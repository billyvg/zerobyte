import { Data, Effect } from "effect";
import { addCommonArgs } from "../helpers/add-common-args";
import { buildEnv } from "../helpers/build-env";
import { buildRepoUrl } from "../helpers/build-repo-url";
import { cleanupTemporaryKeys } from "../helpers/cleanup-temporary-keys";
import type { RepositoryConfig } from "../schemas";
import { logger, safeSpawn } from "../../node";
import { createResticError, isResticError } from "../error";
import type { ResticDeps } from "../types";
import { toMessage } from "../../utils";
import { createUsageFold, type NcduSizeMode, type NcduSnapshotHeader, type UsageTree } from "../../usage";
import { createNcduParser } from "../../usage/parse-ncdu";

class ResticLsNcduCommandError extends Data.TaggedError("ResticLsNcduCommandError")<{
	cause: unknown;
	message: string;
}> {}

export type LsNcduResult = {
	snapshot: NcduSnapshotHeader | null;
	tree: UsageTree;
};

export type LsNcduOptions = {
	organizationId: string;
	signal?: AbortSignal;
	sizeMode?: NcduSizeMode;
	onProgress?: (progress: { entries: number; bytes: number }) => void;
};

/** Progress is for a human watching a spinner, not a precise meter. */
const PROGRESS_INTERVAL_MS = 1000;

/**
 * Reads a snapshot's directory sizes straight out of the repository.
 *
 * `restic ls --ncdu` is restic's own accounting of what the snapshot contains,
 * so the numbers are the snapshot's rather than an approximation reconstructed
 * from somewhere else. The output is streamed through an incremental parser and
 * folded as it arrives, so a snapshot with millions of files does not have to
 * fit in memory.
 *
 * `--no-lock` is safe here: `ls` only reads, and skipping the lock avoids a
 * write round-trip against the backend for what is a read-only question.
 */
export const lsNcdu = (config: RepositoryConfig, snapshotId: string, options: LsNcduOptions, deps: ResticDeps) => {
	return Effect.tryPromise({
		try: async () => {
			const repoUrl = buildRepoUrl(config);
			const env = await buildEnv(config, options.organizationId, deps);

			const args: string[] = ["--repo", repoUrl, "ls", "--ncdu", "--no-lock"];

			// restic rejects --json alongside --ncdu outright.
			addCommonArgs(args, env, config, { includeJson: false });
			args.push("--", snapshotId);

			const fold = createUsageFold({ limits: undefined });
			let snapshot: NcduSnapshotHeader | null = null;
			let entries = 0;
			let bytes = 0;
			let lastProgressAt = 0;

			const parser = createNcduParser({
				fold,
				sizeMode: options.sizeMode,
				onSnapshot: (header) => {
					snapshot = header;
				},
			});

			logger.debug(`Running restic ls --ncdu with args: ${args.join(" ")}`);

			const res = await safeSpawn({
				command: deps.resticCommand ?? "restic",
				args,
				env,
				signal: options.signal,
				stdoutMode: "raw",
				onSpawn: (child) => {
					// setEncoding gives whole characters, so a chunk boundary can never
					// split a multi-byte name down the middle.
					child.stdout?.setEncoding("utf8");
					child.stdout?.on("data", (chunk: string) => {
						entries += 1;
						bytes += chunk.length;
						parser.write(chunk);

						const now = Date.now();
						if (options.onProgress && now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
							lastProgressAt = now;
							options.onProgress({ entries, bytes });
						}
					});
				},
			});

			await cleanupTemporaryKeys(env, deps);

			if (res.exitCode !== 0) {
				logger.error(`Restic ls --ncdu failed: ${res.stderr || res.error}`);
				throw createResticError(res.exitCode, res.stderr || res.error);
			}

			return { snapshot, tree: fold.finish() } satisfies LsNcduResult;
		},
		catch: (error) => {
			if (isResticError(error)) {
				return error;
			}

			return new ResticLsNcduCommandError({
				cause: error,
				message: toMessage(error),
			});
		},
	});
};
