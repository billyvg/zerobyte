import { gunzipSync, gzipSync } from "node:zlib";
import { logger } from "@zerobyte/core/node";
import { parentPath, USAGE_TREE_FORMAT_VERSION, type UsageTree } from "@zerobyte/core/usage";
import { cache } from "../../../utils/cache";
import type { SnapshotUsageDirectory, SnapshotUsageEntry, SnapshotUsageMeta } from "~/schemas/snapshot-usage";

/**
 * Usage trees live in the derived cache, not in the application database.
 *
 * Everything here is recomputable from the repository with `restic ls --ncdu`,
 * so it is a cache and nothing more — restic stays the single source of truth
 * for what a snapshot contains. Dropping `cache.db` loses nothing but time.
 *
 * The key sits outside the `repo:<id>:` namespace on purpose: that prefix is
 * cleared after every backup, and a snapshot's contents never change once
 * written, so there is no reason to recompute a tree just because a *different*
 * snapshot was created.
 */
const usageKey = (repositoryId: string, snapshotId: string) =>
	`snapshot-usage:v${USAGE_TREE_FORMAT_VERSION}:${repositoryId}:${snapshotId}`;

const usagePrefix = (repositoryId: string) => `snapshot-usage:v${USAGE_TREE_FORMAT_VERSION}:${repositoryId}:`;

/** Snapshots are immutable, so a stored tree only expires to bound disk use. */
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 90;

/** Inflating and indexing a multi-megabyte tree per request would be wasteful. */
const MEMORY_CACHE_SIZE = 2;

type StoredTree = {
	scannedAt: number;
	durationMs: number;
	/** Gzipped JSON, base64 encoded: the cache stores JSON strings. */
	gzip: string;
};

export type IndexedTree = {
	key: string;
	scannedAt: number;
	meta: SnapshotUsageMeta;
	/** Children of each directory, largest first. */
	children: Map<string, SnapshotUsageEntry[]>;
	/** Full stats per directory, including children pruning dropped. */
	directoryDetails: Map<string, SnapshotUsageDirectory>;
};

const memoryCache: IndexedTree[] = [];

const readMemoryCache = (key: string, scannedAt: number) => {
	const index = memoryCache.findIndex((entry) => entry.key === key && entry.scannedAt === scannedAt);
	if (index < 0) return undefined;

	const [entry] = memoryCache.splice(index, 1);
	if (entry) memoryCache.unshift(entry);
	return entry;
};

const writeMemoryCache = (entry: IndexedTree) => {
	memoryCache.unshift(entry);
	memoryCache.length = Math.min(memoryCache.length, MEMORY_CACHE_SIZE);
};

export const clearSnapshotUsageCache = () => {
	memoryCache.length = 0;
};

const share = (value: number, total: number) => (total > 0 ? value / total : 0);

const buildIndex = (key: string, stored: StoredTree, tree: UsageTree): IndexedTree => {
	const meta: SnapshotUsageMeta = {
		scannedAt: stored.scannedAt,
		durationMs: stored.durationMs,
		totalSize: tree.totals.size,
		fileCount: tree.totals.fileCount,
		dirCount: tree.totals.dirCount,
		roots: tree.roots,
		skipped: tree.skipped,
		appliedMinSize: tree.appliedMinSize,
	};

	const directoryDetails = new Map<string, SnapshotUsageDirectory>();
	const directories: SnapshotUsageEntry[] = [];
	const bySize = new Map<string, number>();

	for (const dir of tree.dirs) {
		bySize.set(dir.path, dir.size);
		directoryDetails.set(dir.path, {
			path: dir.path,
			name: dir.name,
			size: dir.size,
			ownSize: dir.ownSize,
			fileCount: dir.fileCount,
			dirCount: dir.dirCount,
			maxMtime: dir.maxMtime,
			truncatedChildren: dir.truncatedChildren,
		});
		directories.push({
			path: dir.path,
			name: dir.name,
			type: "dir",
			size: dir.size,
			shareOfParent: 0,
			shareOfTotal: share(dir.size, tree.totals.size),
			fileCount: dir.fileCount,
			dirCount: dir.dirCount,
			maxMtime: dir.maxMtime,
		});
	}

	const files: SnapshotUsageEntry[] = tree.files.map((file) => ({
		path: file.path,
		name: file.path.slice(file.path.lastIndexOf("/") + 1),
		type: "file" as const,
		size: file.size,
		shareOfParent: 0,
		shareOfTotal: share(file.size, tree.totals.size),
		maxMtime: file.mtime,
	}));

	const children = new Map<string, SnapshotUsageEntry[]>();

	for (const entry of [...directories, ...files]) {
		const parent = parentPath(entry.path);
		if (parent === null) continue;

		const bucket = children.get(parent);
		if (bucket) bucket.push(entry);
		else children.set(parent, [entry]);
	}

	for (const [parent, bucket] of children) {
		const parentSize = bySize.get(parent) ?? bucket.reduce((sum, entry) => sum + entry.size, 0);
		for (const entry of bucket) {
			entry.shareOfParent = share(entry.size, parentSize);
		}
		bucket.sort((a, b) => b.size - a.size);
	}

	return { key, scannedAt: stored.scannedAt, meta, children, directoryDetails };
};

export const saveUsageTree = (params: {
	repositoryId: string;
	snapshotId: string;
	durationMs: number;
	tree: UsageTree;
}) => {
	// Directory-path JSON compresses roughly ten to one, which keeps a large
	// snapshot's tree to a few hundred kilobytes in the cache.
	const gzip = gzipSync(Buffer.from(JSON.stringify(params.tree), "utf-8")).toString("base64");

	const stored: StoredTree = { scannedAt: Date.now(), durationMs: params.durationMs, gzip };
	cache.set(usageKey(params.repositoryId, params.snapshotId), stored, CACHE_TTL_SECONDS);
	clearSnapshotUsageCache();
};

export const deleteUsageTrees = (repositoryId: string, snapshotIds: string[]) => {
	for (const snapshotId of snapshotIds) {
		cache.del(usageKey(repositoryId, snapshotId));
	}
	clearSnapshotUsageCache();
};

/** Drops every stored tree for a repository, e.g. when the repository is removed. */
export const deleteAllUsageTrees = (repositoryId: string) => {
	cache.delByPrefix(usagePrefix(repositoryId));
	clearSnapshotUsageCache();
};

/** Loads a snapshot's tree, inflated and indexed for drill-down. */
export const loadUsageTree = (repositoryId: string, snapshotId: string): IndexedTree | undefined => {
	const key = usageKey(repositoryId, snapshotId);
	const stored = cache.get<StoredTree>(key);
	if (!stored) return undefined;

	const cached = readMemoryCache(key, stored.scannedAt);
	if (cached) return cached;

	let tree: UsageTree;
	try {
		tree = JSON.parse(gunzipSync(Buffer.from(stored.gzip, "base64")).toString("utf-8")) as UsageTree;
	} catch (error) {
		logger.error(`Failed to read cached usage tree for snapshot ${snapshotId}: ${String(error)}`);
		cache.del(key);
		return undefined;
	}

	const indexed = buildIndex(key, stored, tree);
	writeMemoryCache(indexed);

	return indexed;
};
