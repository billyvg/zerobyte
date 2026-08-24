import type {
	SnapshotUsageDiffDirectory,
	SnapshotUsageDiffEntry,
	SnapshotUsageDiffStatus,
} from "~/schemas/snapshot-usage";
import type { IndexedTree } from "./snapshot-usage-store";

/**
 * Merges one directory's children across two indexed trees into a delta view,
 * largest change first.
 *
 * Pure and DB-free: both trees are already loaded and indexed, so this is just
 * a merge over the two children maps.
 */
export const diffUsageDirectory = (
	current: IndexedTree,
	against: IndexedTree,
	path: string,
	limit: number,
): { directory: SnapshotUsageDiffDirectory | null; entries: SnapshotUsageDiffEntry[]; totalEntries: number } => {
	const currentDir = current.directoryDetails.get(path);
	const againstDir = against.directoryDetails.get(path);

	const directory: SnapshotUsageDiffDirectory | null =
		currentDir || againstDir
			? {
					path,
					existsInCurrent: currentDir !== undefined,
					existsInAgainst: againstDir !== undefined,
					currentSize: currentDir?.size ?? 0,
					againstSize: againstDir?.size ?? 0,
					delta: (currentDir?.size ?? 0) - (againstDir?.size ?? 0),
				}
			: null;

	const byPath = new Map<
		string,
		{ name: string; type: "file" | "dir"; currentSize?: number; againstSize?: number }
	>();

	for (const entry of current.children.get(path) ?? []) {
		byPath.set(entry.path, { name: entry.name, type: entry.type, currentSize: entry.size });
	}
	for (const entry of against.children.get(path) ?? []) {
		const existing = byPath.get(entry.path);
		if (existing) {
			existing.againstSize = entry.size;
		} else {
			byPath.set(entry.path, { name: entry.name, type: entry.type, againstSize: entry.size });
		}
	}

	const entries: SnapshotUsageDiffEntry[] = Array.from(byPath.entries()).map(([entryPath, entry]) => {
		const currentSize = entry.currentSize ?? 0;
		const againstSize = entry.againstSize ?? 0;
		const delta = currentSize - againstSize;

		const status: SnapshotUsageDiffStatus =
			entry.againstSize === undefined
				? "added"
				: entry.currentSize === undefined
					? "removed"
					: delta !== 0
						? "changed"
						: "unchanged";

		return {
			path: entryPath,
			name: entry.name,
			type: entry.type,
			status,
			currentSize,
			againstSize,
			delta,
		};
	});

	entries.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.currentSize - a.currentSize);

	return { directory, entries: entries.slice(0, limit), totalEntries: entries.length };
};
