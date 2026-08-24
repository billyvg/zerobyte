import crypto from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "~/server/app";
import { db } from "~/server/db/db";
import { repositoriesTable } from "~/server/db/schema";
import { generateShortId } from "~/server/utils/id";
import { createTestSession } from "~/test/helpers/auth";
import { createUsageFold } from "@zerobyte/core/usage";
import type { UsageNode } from "@zerobyte/core/usage";
import { clearSnapshotUsageCache, saveUsageTree } from "../helpers/snapshot-usage-store";

const app = createApp();

let session: Awaited<ReturnType<typeof createTestSession>>;

beforeAll(async () => {
	session = await createTestSession();
});

beforeEach(() => {
	clearSnapshotUsageCache();
});

afterEach(async () => {
	clearSnapshotUsageCache();
});

const createRepository = async (organizationId: string) => {
	const [repository] = await db
		.insert(repositoriesTable)
		.values({
			id: crypto.randomUUID(),
			shortId: generateShortId(),
			name: `Repository-${crypto.randomUUID()}`,
			type: "local",
			config: { backend: "local", path: `/tmp/${crypto.randomUUID()}` },
			organizationId,
		})
		.returning();

	if (!repository) throw new Error("Failed to create repository");
	return repository;
};

const saveTree = (repositoryId: string, organizationId: string, snapshotId: string, nodes: UsageNode[]) => {
	const fold = createUsageFold({ roots: ["/data"] });
	for (const node of nodes) fold.push(node);

	saveUsageTree({
		repositoryId,
		snapshotId,
		durationMs: 42,
		tree: fold.finish(),
	});
};

/**
 *   before                          after
 *   /data           1300            /data              1800
 *     /media          1000  (movie)   /media              1500  (movie grew)
 *     /docs            300            /docs                300
 *       a.txt           200             a.txt               200
 *       b.txt           100             c.txt (new)         100
 */
const seedBefore = (repositoryId: string, organizationId: string, snapshotId: string) =>
	saveTree(repositoryId, organizationId, snapshotId, [
		{ path: "/data", type: "dir" },
		{ path: "/data/media", type: "dir" },
		{ path: "/data/media/movie.iso", type: "file", size: 1000, mtime: 5000 },
		{ path: "/data/docs", type: "dir" },
		{ path: "/data/docs/a.txt", type: "file", size: 200, mtime: 1000 },
		{ path: "/data/docs/b.txt", type: "file", size: 100, mtime: 2000 },
	]);

const seedAfter = (repositoryId: string, organizationId: string, snapshotId: string) =>
	saveTree(repositoryId, organizationId, snapshotId, [
		{ path: "/data", type: "dir" },
		{ path: "/data/media", type: "dir" },
		{ path: "/data/media/movie.iso", type: "file", size: 1500, mtime: 6000 },
		{ path: "/data/docs", type: "dir" },
		{ path: "/data/docs/a.txt", type: "file", size: 200, mtime: 1000 },
		{ path: "/data/docs/c.txt", type: "file", size: 100, mtime: 7000 },
	]);

describe("GET /repositories/:shortId/snapshots/:snapshotId/usage/diff", () => {
	test("requires authentication", async () => {
		const repository = await createRepository(session.organizationId);
		const res = await app.request(
			`/api/v1/repositories/${repository.shortId}/snapshots/after/usage/diff?against=before`,
		);

		expect(res.status).toBe(401);
	});

	test("reports which side is missing rather than erroring", async () => {
		const repository = await createRepository(session.organizationId);
		seedAfter(repository.id, session.organizationId, "after");

		const res = await app.request(
			`/api/v1/repositories/${repository.shortId}/snapshots/after/usage/diff?against=before`,
			{ headers: session.headers },
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "missing", missing: "against" });
	});

	test("reports both missing when neither snapshot has a tree", async () => {
		const repository = await createRepository(session.organizationId);

		const res = await app.request(
			`/api/v1/repositories/${repository.shortId}/snapshots/after/usage/diff?against=before`,
			{ headers: session.headers },
		);

		expect(await res.json()).toEqual({ status: "missing", missing: "both" });
	});

	test("diffs the root, biggest change first", async () => {
		const repository = await createRepository(session.organizationId);
		seedBefore(repository.id, session.organizationId, "before");
		seedAfter(repository.id, session.organizationId, "after");

		const res = await app.request(
			`/api/v1/repositories/${repository.shortId}/snapshots/after/usage/diff?against=before`,
			{ headers: session.headers },
		);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.status).toBe("ready");
		expect(body.path).toBe("/data");
		expect(body.meta.current.totalSize).toBe(1800);
		expect(body.meta.against.totalSize).toBe(1300);
		expect(body.directory).toMatchObject({ currentSize: 1800, againstSize: 1300, delta: 500 });
		expect(body.entries.map((e: { name: string }) => e.name)).toEqual(["media", "docs"]);
		expect(body.entries[0]).toMatchObject({
			name: "media",
			status: "changed",
			currentSize: 1500,
			againstSize: 1000,
			delta: 500,
		});
	});

	test("marks a path only present in the current snapshot as added", async () => {
		const repository = await createRepository(session.organizationId);
		seedBefore(repository.id, session.organizationId, "before");
		seedAfter(repository.id, session.organizationId, "after");

		const res = await app.request(
			`/api/v1/repositories/${repository.shortId}/snapshots/after/usage/diff?against=before&path=${encodeURIComponent("/data/docs")}`,
			{ headers: session.headers },
		);
		const body = await res.json();

		const added = body.entries.find((e: { name: string }) => e.name === "c.txt");
		const removed = body.entries.find((e: { name: string }) => e.name === "b.txt");
		const unchanged = body.entries.find((e: { name: string }) => e.name === "a.txt");

		expect(added).toMatchObject({ status: "added", currentSize: 100, againstSize: 0, delta: 100 });
		expect(removed).toMatchObject({ status: "removed", currentSize: 0, againstSize: 100, delta: -100 });
		expect(unchanged).toMatchObject({ status: "unchanged", delta: 0 });
	});

	test("does not leak another organization's tree", async () => {
		const otherSession = await createTestSession();
		const repository = await createRepository(session.organizationId);
		seedBefore(repository.id, session.organizationId, "before");
		seedAfter(repository.id, session.organizationId, "after");

		const res = await app.request(
			`/api/v1/repositories/${repository.shortId}/snapshots/after/usage/diff?against=before`,
			{ headers: otherSession.headers },
		);

		expect([403, 404]).toContain(res.status);
	});
});
