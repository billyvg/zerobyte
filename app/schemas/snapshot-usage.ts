import { z } from "zod";

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
	/** When the tree was read out of the repository. */
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
