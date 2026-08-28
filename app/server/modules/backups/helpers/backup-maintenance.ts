import { logger } from "@zerobyte/core/node";
import type { RetentionPolicy } from "@zerobyte/core/restic";
import type { Repository } from "../../../db/schema";
import { restic } from "../../../core/restic";
import { repoMutex } from "../../../core/repository-mutex";
import { cache, cacheKeys } from "../../../utils/cache";
import { deleteUsageTrees } from "../../repositories/helpers/snapshot-usage-store";
import { runEffectPromise } from "../../../utils/errors";

type ForgetExecutionPlan = {
	repository: Repository;
	retentionPolicy: RetentionPolicy;
	tag: string;
	organizationId: string;
	signal?: AbortSignal;
};

export async function applyRetentionPolicy(plan: ForgetExecutionPlan) {
	logger.info(`running retention policy (forget) for repository ${plan.repository.id}`);
	const result = await runEffectPromise(
		restic.forget(plan.repository.config, plan.retentionPolicy, {
			tag: plan.tag,
			organizationId: plan.organizationId,
			signal: plan.signal,
		}),
	);
	cache.delByPrefix(cacheKeys.repository.all(plan.repository.id));

	// Cached usage trees live outside the repository cache prefix, so forgotten
	// snapshots would otherwise leave theirs behind indefinitely.
	const forgotten = (result.data ?? []).flatMap((group) => group.remove ?? []).map((snapshot) => snapshot.short_id);
	deleteUsageTrees(plan.repository.id, forgotten);

	logger.info(`Retention policy applied successfully for repository ${plan.repository.id}`);
}

export async function executeForget(plan: ForgetExecutionPlan) {
	const releaseLock = await repoMutex.acquireExclusive(plan.repository.id, `forget:${plan.tag}`, plan.signal);

	try {
		await applyRetentionPolicy(plan);
	} finally {
		releaseLock();
	}
}
