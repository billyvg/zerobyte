import { z } from "zod";

/**
 * Where a snapshot's size tree came from.
 *
 * The two are not interchangeable and the UI must say which it is showing:
 *
 * - `backup` — walked from the locally mounted source while the backup ran.
 *   Costs nothing at the repository, and includes paths the schedule excludes,
 *   so its total is what was *on disk*, not what was stored.
 * - `scan` — read back out of the repository with `restic ls`. Describes only
 *   what the snapshot actually contains.
 */
export const snapshotUsageSources = ["backup", "scan"] as const;
export const snapshotUsageSourceSchema = z.enum(snapshotUsageSources);
export type SnapshotUsageSource = (typeof snapshotUsageSources)[number];

export const snapshotUsageEntrySchema = z.object({
	path: z.string(),
	name: z.string(),
	type: z.enum(["file", "dir"]),
	/** Apparent size: for a directory, the total of its whole subtree. */
	size: z.number(),
	/** Share of the parent directory, 0–1. */
	shareOfParent: z.number(),
	/** Share of the whole tree, 0–1. */
	shareOfTotal: z.number(),
	fileCount: z.number().optional(),
	dirCount: z.number().optional(),
	maxMtime: z.number().optional(),
});
export type SnapshotUsageEntry = z.infer<typeof snapshotUsageEntrySchema>;

export const snapshotUsageDirectorySchema = z.object({
	path: z.string(),
	name: z.string(),
	size: z.number(),
	ownSize: z.number(),
	fileCount: z.number(),
	dirCount: z.number(),
	maxMtime: z.number(),
	/** Children pruned out of the stored tree, so the row totals still reconcile. */
	truncatedChildren: z.object({ count: z.number(), size: z.number() }).optional(),
});
export type SnapshotUsageDirectory = z.infer<typeof snapshotUsageDirectorySchema>;

export const snapshotUsageMetaSchema = z.object({
	source: snapshotUsageSourceSchema,
	scannedAt: z.number(),
	durationMs: z.number(),
	totalSize: z.number(),
	fileCount: z.number(),
	dirCount: z.number(),
	roots: z.array(z.string()),
	/** Entries the producer could not read. */
	skipped: z.number(),
	/** Size threshold pruning settled on; 0 means nothing was pruned. */
	appliedMinSize: z.number(),
});
export type SnapshotUsageMeta = z.infer<typeof snapshotUsageMetaSchema>;

/**
 * How one path's size changed between the two snapshots being compared.
 *
 * `added`/`removed` mean the path was only found on one side, not that it was
 * necessarily created or deleted — it may simply have fallen below the size
 * threshold one of the trees was pruned to. `meta.appliedMinSize` on either
 * side is the tell.
 */
export const snapshotUsageDiffStatuses = ["added", "removed", "changed", "unchanged"] as const;
export const snapshotUsageDiffStatusSchema = z.enum(snapshotUsageDiffStatuses);
export type SnapshotUsageDiffStatus = (typeof snapshotUsageDiffStatuses)[number];

export const snapshotUsageDiffEntrySchema = z.object({
	path: z.string(),
	name: z.string(),
	type: z.enum(["file", "dir"]),
	status: snapshotUsageDiffStatusSchema,
	/** Size in the snapshot being viewed; 0 when the path doesn't exist there. */
	currentSize: z.number(),
	/** Size in the snapshot being compared against; 0 when the path doesn't exist there. */
	againstSize: z.number(),
	/** currentSize - againstSize. */
	delta: z.number(),
});
export type SnapshotUsageDiffEntry = z.infer<typeof snapshotUsageDiffEntrySchema>;

export const snapshotUsageDiffDirectorySchema = z.object({
	path: z.string(),
	existsInCurrent: z.boolean(),
	existsInAgainst: z.boolean(),
	currentSize: z.number(),
	againstSize: z.number(),
	delta: z.number(),
});
export type SnapshotUsageDiffDirectory = z.infer<typeof snapshotUsageDiffDirectorySchema>;

export const snapshotUsageDiffMetaSchema = z.object({
	current: snapshotUsageMetaSchema,
	against: snapshotUsageMetaSchema,
});
export type SnapshotUsageDiffMeta = z.infer<typeof snapshotUsageDiffMetaSchema>;
