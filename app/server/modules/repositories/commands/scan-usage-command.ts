import { logger } from "@zerobyte/core/node";
import { repoMutex } from "../../../core/repository-mutex";
import { restic } from "../../../core/restic";
import type { Repository } from "../../../db/schema";
import { runEffectPromise, toMessage } from "../../../utils/errors";
import type { TaskResult } from "~/schemas/tasks";
import { runTaskLifecycle } from "../../tasks/tasks.lifecycle";
import { taskStore } from "../../tasks/tasks.store";
import { createTaskProgressBuffer } from "../../tasks/progress-buffer";
import { saveUsageTree } from "../helpers/snapshot-usage-store";

type ScanUsageCommandParams = {
	repository: Repository;
	snapshotId: string;
};

type ScanUsageTaskResult = Extract<TaskResult, { kind: "snapshotUsage" }>;

const RESOURCE_TYPE = "repository" as const;

/**
 * Reads a snapshot's directory sizes out of the repository with
 * `restic ls --ncdu` and caches the folded result.
 *
 * Runs as a task rather than inline in a request: on a cold restic metadata
 * cache this walks every tree blob in the snapshot, which can take minutes and
 * is worth showing progress for. A shared repository lock is enough — `ls` only
 * reads — so this does not block backups.
 */
export const createScanUsageCommand = (params: ScanUsageCommandParams) => {
	const { repository, snapshotId } = params;
	const organizationId = repository.organizationId;

	const taskResource = {
		organizationId,
		kind: "snapshotUsage" as const,
		resourceType: RESOURCE_TYPE,
		resourceId: repository.shortId,
		operationKey: snapshotId,
	};

	return {
		/** Returns the already-running task when one exists, so this is idempotent. */
		findActive: () => taskStore.findActiveByResource(taskResource),

		start: () => {
			const existing = taskStore.findActiveByResource(taskResource);
			if (existing) {
				return { taskId: existing.id, status: "already-running" as const };
			}

			const task = taskStore.create({
				organizationId,
				resourceType: RESOURCE_TYPE,
				resourceId: repository.shortId,
				operationKey: snapshotId,
				targetDisplayName: repository.name,
				input: { kind: "snapshotUsage", repositoryId: repository.id, snapshotId },
			});

			const progressBuffer = createTaskProgressBuffer(task.id, {
				intervalMs: 500,
				onError: (error) => {
					logger.error(`Failed to persist usage scan progress for ${task.id}: ${toMessage(error)}`);
				},
			});

			void runTaskLifecycle({
				taskId: task.id,
				label: "snapshot usage scan",
				cancellable: true,
				prepare: async (signal) => repoMutex.acquireShared(repository.id, `usage:${snapshotId}`, signal),
				run: async (signal): Promise<ScanUsageTaskResult> => {
					const startedAt = Date.now();

					try {
						const { tree } = await runEffectPromise(
							restic.lsNcdu(repository.config, snapshotId, {
								organizationId,
								signal,
								onProgress: ({ bytes }) => {
									progressBuffer.update({ kind: "snapshotUsage", bytesRead: bytes });
								},
							}),
						);

						saveUsageTree({
							repositoryId: repository.id,
							snapshotId,
							durationMs: Date.now() - startedAt,
							tree,
						});

						return {
							kind: "snapshotUsage",
							totalSize: tree.totals.size,
							fileCount: tree.totals.fileCount,
							dirCount: tree.totals.dirCount,
						};
					} finally {
						progressBuffer.flush();
					}
				},
			}).finally(() => {
				progressBuffer.dispose();
			});

			return { taskId: task.id, status: "started" as const };
		},
	};
};
