import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createUsageFold } from "../fold";
import { createNcduParser, type NcduSnapshotHeader } from "../parse-ncdu";
import type { UsageTree } from "../types";

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", `${name}.json`), "utf-8");

/** Feeds the fixture through in chunks, since the real source is a byte stream. */
const parse = (
	source: string,
	options: { chunkSize?: number; sizeMode?: "apparent" | "disk" } = {},
): { tree: UsageTree; snapshot: NcduSnapshotHeader | null } => {
	const fold = createUsageFold();
	let snapshot: NcduSnapshotHeader | null = null;

	const parser = createNcduParser({
		fold,
		sizeMode: options.sizeMode,
		onSnapshot: (header) => {
			snapshot = header;
		},
	});

	const chunkSize = options.chunkSize ?? source.length;
	for (let index = 0; index < source.length; index += chunkSize) {
		parser.write(source.slice(index, index + chunkSize));
	}

	return { tree: fold.finish(), snapshot };
};

const dirAt = (tree: UsageTree, dirPath: string) => tree.dirs.find((entry) => entry.path === dirPath);
const fileAt = (tree: UsageTree, filePath: string) => tree.files.find((entry) => entry.path === filePath);

const SRC = "/tmp/claude-0/-home-user-zerobyte/4239e486-7364-56fb-8f54-e9d23cb566d8/scratchpad/src";

describe("createNcduParser", () => {
	describe("against real restic 0.19.1 output", () => {
		it("reads the snapshot header rather than treating it as a node", () => {
			const { snapshot, tree } = parse(fixture("ncdu-simple"));

			expect(snapshot?.hostname).toBe("vm");
			expect(snapshot?.paths).toEqual([SRC]);
			// The header must not have leaked into the tree as a directory.
			expect(tree.dirs.some((entry) => entry.name === "vm")).toBe(false);
		});

		it("totals the whole snapshot to what restic reported it backed up", () => {
			const { tree } = parse(fixture("ncdu-simple"));

			// restic's own summary for this snapshot: total_bytes_processed 102500.
			expect(tree.totals.size).toBe(102_500);
		});

		it("attributes sizes to the right directories", () => {
			const { tree } = parse(fixture("ncdu-simple"));

			expect(dirAt(tree, `${SRC}/media`)?.size).toBe(100_000);
			expect(dirAt(tree, `${SRC}/docs`)?.size).toBe(2500);
			expect(dirAt(tree, `${SRC}/docs/deep`)?.size).toBe(500);
			expect(dirAt(tree, SRC)?.size).toBe(102_500);
		});

		it("separates a directory's own bytes from its subtree", () => {
			const { tree } = parse(fixture("ncdu-simple"));

			const docs = dirAt(tree, `${SRC}/docs`);
			expect(docs?.ownSize).toBe(2000);
			expect(docs?.size).toBe(2500);
		});

		it("builds absolute paths by nesting, since ncdu only gives basenames", () => {
			const { tree } = parse(fixture("ncdu-simple"));

			expect(fileAt(tree, `${SRC}/docs/deep/b.txt`)?.size).toBe(500);
			expect(fileAt(tree, `${SRC}/media/movie.iso`)?.size).toBe(100_000);
		});

		it("keeps an empty directory as a zero-byte entry", () => {
			const { tree } = parse(fixture("ncdu-simple"));

			expect(dirAt(tree, `${SRC}/empty`)?.size).toBe(0);
			expect(dirAt(tree, `${SRC}/empty`)?.fileCount).toBe(0);
		});

		it("records a symlink as a file without following it", () => {
			const { tree } = parse(fixture("ncdu-simple"));

			// `link` points at `media`; it must not duplicate media's 100 KB.
			expect(fileAt(tree, `${SRC}/link`)?.size).toBe(0);
			expect(dirAt(tree, `${SRC}`)?.fileCount).toBe(5);
		});

		it("keeps zero-byte files", () => {
			const { tree } = parse(fixture("ncdu-simple"));

			expect(fileAt(tree, `${SRC}/zero.bin`)).toBeDefined();
		});

		it("reports block-rounded sizes in disk mode", () => {
			const { tree } = parse(fixture("ncdu-simple"), { sizeMode: "disk" });

			// a.txt is 2000 bytes apparent, 2048 on disk.
			expect(fileAt(tree, `${SRC}/docs/a.txt`)?.size).toBe(2048);
		});

		it("converts mtime from seconds to milliseconds", () => {
			const { tree } = parse(fixture("ncdu-simple"));

			const file = fileAt(tree, `${SRC}/media/movie.iso`);
			expect(file?.mtime).toBeGreaterThan(1_700_000_000_000);
			expect(file?.mtime).toBeLessThan(2_000_000_000_000);
		});

		it("handles a snapshot with several root paths", () => {
			const { tree, snapshot } = parse(fixture("ncdu-multiroot"));
			const base = SRC.slice(0, SRC.lastIndexOf("/"));

			expect(snapshot?.paths).toHaveLength(2);
			expect(dirAt(tree, `${base}/src2/other`)?.size).toBe(700);
			expect(dirAt(tree, `${base}/uni`)?.size).toBe(300);
			expect(tree.totals.size).toBe(1000);
		});

		it("handles unicode and escaped quotes in names", () => {
			const { tree } = parse(fixture("ncdu-multiroot"));
			const base = SRC.slice(0, SRC.lastIndexOf("/"));

			expect(dirAt(tree, `${base}/uni/ünï dir`)?.size).toBe(300);
			expect(fileAt(tree, `${base}/uni/ünï dir/spaced "name".txt`)?.size).toBe(300);
		});

		it("produces the same tree however the byte stream is chunked", () => {
			const source = fixture("ncdu-simple");
			const whole = parse(source).tree;

			// A one-byte chunk size splits every string, number and brace.
			for (const chunkSize of [1, 7, 64, 997]) {
				const chunked = parse(source, { chunkSize }).tree;
				expect(chunked.totals).toEqual(whole.totals);
				expect(chunked.dirs).toEqual(whole.dirs);
				expect(chunked.files).toEqual(whole.files);
			}
		});
	});

	describe("robustness", () => {
		it("does not treat a brace inside a filename as an object", () => {
			const source = `[1,2,{"time":"t"},[{"name":"/"},{"name":"we{ird}.txt","asize":10,"mtime":1}]]`;
			const { tree } = parse(source);

			expect(fileAt(tree, "/we{ird}.txt")?.size).toBe(10);
			expect(tree.totals.fileCount).toBe(1);
		});

		it("does not treat a bracket inside a filename as nesting", () => {
			const source = `[1,2,{"time":"t"},[{"name":"/"},[{"name":"a]b["},{"name":"c.txt","asize":5,"mtime":1}]]]`;
			const { tree } = parse(source);

			expect(dirAt(tree, "/a]b[")?.size).toBe(5);
		});

		it("handles an escaped backslash before a quote", () => {
			const source = `[1,2,{"time":"t"},[{"name":"/"},{"name":"back\\\\slash","asize":3,"mtime":1}]]`;
			const { tree } = parse(source);

			expect(fileAt(tree, "/back\\slash")?.size).toBe(3);
		});

		it("counts an unparseable entry as skipped instead of failing", () => {
			const source = `[1,2,{"time":"t"},[{"name":"/"},{"name":,,,},{"name":"ok.txt","asize":4,"mtime":1}]]`;
			const { tree } = parse(source);

			expect(tree.skipped).toBe(1);
			expect(fileAt(tree, "/ok.txt")?.size).toBe(4);
		});

		it("treats a missing size as zero", () => {
			const source = `[1,2,{"time":"t"},[{"name":"/"},{"name":"nosize.txt","mtime":1}]]`;
			const { tree } = parse(source);

			expect(tree.totals.fileCount).toBe(1);
			expect(tree.totals.size).toBe(0);
		});

		it("produces an empty tree for an empty snapshot", () => {
			const source = `[1,2,{"time":"t"},[{"name":"/"}]]`;
			const { tree } = parse(source);

			expect(tree.totals.fileCount).toBe(0);
			expect(tree.dirs).toHaveLength(1);
		});
	});
});
