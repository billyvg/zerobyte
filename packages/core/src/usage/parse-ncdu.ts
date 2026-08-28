import type { UsageFold } from "./fold.js";

/**
 * Which size `restic ls --ncdu` reports to use.
 *
 * - `apparent` (`asize`) is the file's own length. This is what restic stored.
 * - `disk` (`dsize`) is that length rounded up to filesystem blocks, which is
 *   what plain `du` and ncdu show by default.
 */
export type NcduSizeMode = "apparent" | "disk";

export type ParseNcduOptions = {
	fold: UsageFold;
	sizeMode?: NcduSizeMode;
	/** Called once the snapshot header object has been read. */
	onSnapshot?: (snapshot: NcduSnapshotHeader) => void;
};

export type NcduSnapshotHeader = {
	time?: string;
	hostname?: string;
	paths?: string[];
	tree?: string;
};

type Frame = {
	/** Absolute path of the directory this array represents. */
	path: string;
	/** Elements seen so far; element 0 carries the directory's own header. */
	elements: number;
};

const joinPath = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

/**
 * Incremental parser for `restic ls --ncdu`.
 *
 * The ncdu export format is a nested structure rather than one object per line:
 *
 *     [1, 2, {snapshot}, [ {"name":"/"}, {file}, [ {dir}, {file} ] ] ]
 *
 * A directory is an array whose *first* element is that directory's own header;
 * everything after it is a file object or a nested directory array.
 *
 * Parsing it with `JSON.parse` would mean holding the whole tree in memory —
 * roughly 180 bytes per entry, so gigabytes on a large snapshot. Instead this
 * walks the byte stream with a small state machine and only ever buffers a
 * single entry object at a time; depth and per-array element counts are enough
 * to tell a directory header from a file. Restic emits depth-first, so the
 * nodes come out in exactly the order the usage fold expects.
 */
export const createNcduParser = (options: ParseNcduOptions) => {
	const { fold, sizeMode = "apparent", onSnapshot } = options;

	const stack: Frame[] = [];

	let depth = 0;
	let inString = false;
	let escaped = false;
	/** Non-null while accumulating an object's raw text. */
	let objectText: string | null = null;
	let objectDepth = 0;
	let sawSnapshotHeader = false;

	const readEntry = (raw: string) => {
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			// A malformed entry is not worth abandoning the whole snapshot for.
			fold.skip();
			return;
		}

		// The wrapper array holds [majver, minver, snapshot, rootdir], so any
		// object directly inside it is the snapshot header rather than a node.
		if (depth <= 1) {
			if (!sawSnapshotHeader) {
				sawSnapshotHeader = true;
				onSnapshot?.(entry as NcduSnapshotHeader);
			}
			return;
		}

		const frame = stack.at(-1);
		if (!frame) return;

		const name = typeof entry.name === "string" ? entry.name : "";
		const isDirectoryHeader = frame.elements === 0;
		frame.elements += 1;

		if (isDirectoryHeader) {
			// The root header is literally {"name":"/"}; deeper ones are basenames.
			frame.path = name === "/" ? "/" : joinPath(stack.at(-2)?.path ?? "/", name);
			fold.push({ path: frame.path, type: "dir", mtime: mtimeOf(entry) });
			return;
		}

		const size = sizeMode === "disk" ? numberOf(entry.dsize) : numberOf(entry.asize);
		fold.push({ path: joinPath(frame.path, name), type: "file", size, mtime: mtimeOf(entry) });
	};

	const write = (chunk: string) => {
		for (const char of chunk) {
			if (objectText !== null) {
				objectText += char;

				if (inString) {
					if (escaped) escaped = false;
					else if (char === "\\") escaped = true;
					else if (char === '"') inString = false;
					continue;
				}

				if (char === '"') inString = true;
				else if (char === "{") objectDepth += 1;
				else if (char === "}") {
					objectDepth -= 1;
					if (objectDepth === 0) {
						const raw = objectText;
						objectText = null;
						readEntry(raw);
					}
				}
				continue;
			}

			if (inString) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') inString = false;
				continue;
			}

			if (char === '"') {
				inString = true;
			} else if (char === "{") {
				objectText = "{";
				objectDepth = 1;
			} else if (char === "[") {
				depth += 1;
				// Depth 1 is the wrapper array; every deeper array is a directory.
				if (depth >= 2) stack.push({ path: "/", elements: 0 });
			} else if (char === "]") {
				depth -= 1;
				if (depth >= 1) stack.pop();
			}
		}
	};

	return { write };
};

const numberOf = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const mtimeOf = (entry: Record<string, unknown>) => {
	const seconds = entry.mtime;
	if (typeof seconds !== "number" || !Number.isFinite(seconds)) return 0;
	return Math.trunc(seconds * 1000);
};
