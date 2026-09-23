import { useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUp, Info, X } from "lucide-react";
import { toast } from "sonner";
import { isPathWithin, normalizeAbsolutePath } from "@zerobyte/core/utils";
import {
	getSnapshotUsageDiffOptions,
	getSnapshotUsageOptions,
	listSnapshotsOptions,
	scanSnapshotUsageMutation,
} from "~/client/api-client/@tanstack/react-query.gen";
import { Card, CardContent, CardHeader, CardTitle } from "~/client/components/ui/card";
import { Button } from "~/client/components/ui/button";
import { ByteSize } from "~/client/components/bytes-size";
import { Skeleton } from "~/client/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/client/components/ui/select";
import { useTimeFormat } from "~/client/lib/datetime";
import { parseError } from "~/client/lib/errors";
import { cn } from "~/client/lib/utils";
import { createPathPrefixFns } from "~/client/lib/volume-path";
import type {
	SnapshotUsageDiffDirectory,
	SnapshotUsageDiffEntry,
	SnapshotUsageDiffMeta,
	SnapshotUsageEntry,
} from "~/schemas/snapshot-usage";
import { UsageRow, type UsageRowDiff } from "./usage-row";
import { UsageBreadcrumb } from "./usage-breadcrumb";
import { ExcludeDialog } from "./exclude-dialog";
import { UsageEmptyState, UsageScanningState } from "./usage-empty-state";

type OwningSchedule = {
	shortId: string;
	name: string;
	excludePatterns: string[] | null;
};

type Props = {
	repositoryId: string;
	snapshotId: string;
	schedule: OwningSchedule | null;
	/** Repository-side size, for the honest comparison against apparent size. */
	repositorySize?: number;
	/** The volume's mount path, so paths can be shown relative to it instead of the host filesystem. */
	displayBasePath?: string;
};

/** Radix Select would otherwise toggle between controlled and uncontrolled as `against` goes to/from undefined, which stops the trigger from clearing back to its placeholder — so the "not comparing" state gets its own stable value instead of undefined. */
const NOT_COMPARING = "__not-comparing__";

/**
 * Mirrors the diff endpoint's "ready" response shape, spelled out by hand.
 *
 * The generated `GetSnapshotUsageDiffResponse` type is a `status`-discriminated
 * union, but narrowing it with `diffData.status === "ready"` and then reusing
 * that value in a later expression trips up this project's TypeScript version
 * (loses the narrowing and reports the members as missing) — narrowing into
 * this plain, non-generated type sidesteps it.
 */
type DiffReady = {
	meta: SnapshotUsageDiffMeta;
	path: string;
	directory: SnapshotUsageDiffDirectory | null;
	entries: SnapshotUsageDiffEntry[];
	totalEntries: number;
};

const SkeletonRows = () => (
	<div className="space-y-2 p-4">
		{Array.from({ length: 6 }, (_, index) => (
			<Skeleton key={index} className="h-9 w-full" />
		))}
	</div>
);

export const UsageExplorer = ({ repositoryId, snapshotId, schedule, repositorySize, displayBasePath }: Props) => {
	const [path, setPath] = useState<string | undefined>(undefined);
	const [against, setAgainst] = useState(NOT_COMPARING);
	const [entryToExclude, setEntryToExclude] = useState<SnapshotUsageEntry | null>(null);
	const { formatDateTime } = useTimeFormat();

	const isComparing = against !== NOT_COMPARING;

	const { data: snapshots } = useQuery(listSnapshotsOptions({ path: { shortId: repositoryId } }));

	// Newest first, and never the snapshot being viewed — comparing it to itself
	// isn't useful.
	const candidates = useMemo(
		() => (snapshots ?? []).filter((s) => s.short_id !== snapshotId).sort((a, b) => b.time - a.time),
		[snapshots, snapshotId],
	);

	// The baseline: always fetched regardless of compare mode, so it can double
	// as the stable source for breadcrumb/path navigation even while a
	// comparison is loading, and so switching in and out of compare mode never
	// has to re-fetch it.
	const usageQuery = useQuery({
		...getSnapshotUsageOptions({
			path: { shortId: repositoryId, snapshotId },
			query: path ? { path } : {},
		}),
		placeholderData: keepPreviousData,
		// While a read is in flight, poll so the view flips over on its own.
		refetchInterval: (query) => (query.state.data?.status === "scanning" ? 2000 : false),
	});

	const startScan = useMutation({
		...scanSnapshotUsageMutation(),
		onError: (mutationError) => {
			toast.error("Could not start the measurement", { description: parseError(mutationError)?.message });
		},
	});

	const diffQuery = useQuery({
		...getSnapshotUsageDiffOptions({
			path: { shortId: repositoryId, snapshotId },
			query: { against: isComparing ? against : "", ...(path ? { path } : {}) },
		}),
		enabled: isComparing,
		placeholderData: keepPreviousData,
		// After measuring the other snapshot from here, poll until its tree lands.
		refetchInterval: (query) =>
			query.state.data?.status === "missing" &&
			startScan.isSuccess &&
			startScan.variables?.path.snapshotId === against
				? 2000
				: false,
	});

	const usageData = usageQuery.data;
	const diffData = diffQuery.data;

	// Only relativize against the volume's mount path when it actually contains
	// this tree — otherwise fall back to showing the real path as-is.
	const root = usageData?.status === "ready" ? (usageData.meta.roots[0] ?? "/") : "/";
	const normalizedDisplayBasePath = normalizeAbsolutePath(displayBasePath ?? "/");
	const effectiveDisplayBasePath = isPathWithin(normalizedDisplayBasePath, root) ? normalizedDisplayBasePath : "/";
	const displayPathFns = useMemo(() => createPathPrefixFns(effectiveDisplayBasePath), [effectiveDisplayBasePath]);

	// Prefer the path just navigated to over the resolved path from the
	// response, which can still be the previous directory's while its own
	// fetch is in flight (see placeholderData above) — otherwise the
	// breadcrumb would lag a step behind the click.
	const currentPath = path ?? (usageData?.status === "ready" ? usageData.path : "/");

	const parent = useMemo(() => {
		if (currentPath === root) return null;

		const index = currentPath.lastIndexOf("/");
		if (index <= 0) return "/";
		const candidate = currentPath.slice(0, index);
		return candidate.length >= root.length ? candidate : root;
	}, [currentPath, root]);

	const picker = (
		<div className="flex items-center gap-1">
			<Select
				value={against}
				onValueChange={(value) => {
					setAgainst(value);
					setPath(undefined);
				}}
				disabled={!snapshots || candidates.length === 0}
			>
				<SelectTrigger className="w-full sm:w-96">
					<SelectValue placeholder="Select snapshot to compare to" />
				</SelectTrigger>
				<SelectContent>
					{candidates.map((candidate) => (
						<SelectItem key={candidate.short_id} value={candidate.short_id}>
							{formatDateTime(candidate.time)} ({candidate.short_id})
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{isComparing && (
				<Button
					variant="ghost"
					size="icon"
					className="shrink-0"
					onClick={() => setAgainst(NOT_COMPARING)}
					aria-label="Stop comparing"
					title="Stop comparing"
				>
					<X className="h-4 w-4" />
				</Button>
			)}
		</div>
	);

	if (usageQuery.isLoading) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Usage</CardTitle>
				</CardHeader>
				<CardContent>
					<SkeletonRows />
				</CardContent>
			</Card>
		);
	}

	if (usageQuery.error) {
		return (
			<Card>
				<CardContent className="py-12 text-center">
					<p className="text-destructive">
						{parseError(usageQuery.error)?.message ?? "Failed to load usage"}
					</p>
				</CardContent>
			</Card>
		);
	}

	if (!usageData || usageData.status === "missing") {
		return (
			<UsageEmptyState
				isStarting={startScan.isPending}
				onScan={() => startScan.mutate({ path: { shortId: repositoryId, snapshotId } })}
			/>
		);
	}

	if (usageData.status === "scanning") {
		return <UsageScanningState />;
	}

	const diffReady: DiffReady | null = isComparing && diffData && diffData.status === "ready" ? diffData : null;
	const diffMissing: "current" | "against" | "both" | null =
		isComparing && diffData && diffData.status === "missing" ? diffData.missing : null;
	const totalDelta = diffReady ? diffReady.meta.current.totalSize - diffReady.meta.against.totalSize : 0;

	// While comparing, the diff response (merged across both trees, so it also
	// covers paths only present in the other snapshot) drives which rows show;
	// otherwise it's just this directory's usual listing. Either way, each row
	// still wants its usual size/mtime/share fields when the path is present
	// in the current tree, so those are backfilled from the plain listing.
	const usageByPath = new Map(usageData.entries.map((entry) => [entry.path, entry]));
	const rows: { entry: SnapshotUsageEntry; diff: UsageRowDiff | null }[] = diffReady
		? diffReady.entries.map((diffEntry) => ({
				entry: usageByPath.get(diffEntry.path) ?? {
					path: diffEntry.path,
					name: diffEntry.name,
					type: diffEntry.type,
					size: diffEntry.currentSize,
					shareOfParent: 0,
					shareOfTotal: 0,
				},
				diff: { previousSize: diffEntry.againstSize, delta: diffEntry.delta, status: diffEntry.status },
			}))
		: usageData.entries.map((entry) => ({ entry, diff: null }));

	const totalEntries = diffReady ? diffReady.totalEntries : usageData.totalEntries;
	const cappedByLimit = totalEntries > rows.length;
	const hidden = !isComparing ? usageData.directory?.truncatedChildren : undefined;

	return (
		<>
			<Card
				className={cn(
					"flex flex-col transition-opacity",
					(isComparing ? diffQuery.isFetching && !diffQuery.isLoading : usageQuery.isFetching) &&
						"opacity-60",
				)}
			>
				<CardHeader>
					<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div className="min-w-0">
							<CardTitle>Usage</CardTitle>
							<p className="mt-1 text-sm text-muted-foreground">
								<ByteSize bytes={usageData.meta.totalSize} /> across{" "}
								{usageData.meta.fileCount.toLocaleString()} files, measured{" "}
								{formatDateTime(usageData.meta.scannedAt)}
							</p>
							{diffReady && (
								<p className="mt-1 text-sm text-muted-foreground">
									Compared against {formatDateTime(diffReady.meta.against.scannedAt)}:{" "}
									<ByteSize bytes={diffReady.meta.against.totalSize} /> {"→"}{" "}
									<ByteSize bytes={diffReady.meta.current.totalSize} /> (
									<span
										className={cn(
											totalDelta > 0 && "text-destructive",
											totalDelta < 0 && "text-success",
										)}
									>
										{totalDelta > 0 ? "+" : ""}
										<ByteSize bytes={totalDelta} />
									</span>
									)
								</p>
							)}
						</div>
						<div className="flex flex-col items-stretch gap-2 sm:shrink-0 sm:items-end">
							{picker}
							{parent !== null && (
								<Button
									variant="outline"
									size="sm"
									className="self-end"
									onClick={() => setPath(parent)}
								>
									<ArrowUp className="h-4 w-4" />
									Up
								</Button>
							)}
						</div>
					</div>

					<UsageBreadcrumb
						root={displayPathFns.strip(root)}
						path={displayPathFns.strip(currentPath)}
						onNavigate={(displayPath) => setPath(displayPathFns.add(displayPath))}
					/>
				</CardHeader>

				<CardContent className="p-0">
					{isComparing && diffQuery.isLoading ? (
						<SkeletonRows />
					) : isComparing && diffQuery.error ? (
						<p className="py-12 text-center text-destructive">
							{parseError(diffQuery.error)?.message ?? "Failed to load the comparison"}
						</p>
					) : isComparing && diffMissing ? (
						<div className="flex flex-col items-center gap-3 px-3 py-8 text-center text-sm text-muted-foreground">
							<p>
								{diffMissing === "against"
									? "The snapshot being compared against hasn't been measured yet."
									: "Neither snapshot has been measured yet."}
							</p>
							{startScan.isSuccess && startScan.variables?.path.snapshotId === against ? (
								<p>Measuring… this can take a while for a large snapshot.</p>
							) : (
								<Button
									variant="outline"
									size="sm"
									disabled={startScan.isPending}
									onClick={() =>
										startScan.mutate({ path: { shortId: repositoryId, snapshotId: against } })
									}
								>
									Measure it
								</Button>
							)}
						</div>
					) : (
						<>
							<div className="border-y border-border">
								{rows.length === 0 ? (
									<p className="px-3 py-8 text-center text-sm text-muted-foreground">
										{isComparing
											? "Nothing recorded inside this folder in either snapshot."
											: "Nothing recorded inside this folder."}
									</p>
								) : (
									rows.map(({ entry, diff }) => (
										<UsageRow
											key={entry.path}
											entry={entry}
											diff={diff}
											displayPath={displayPathFns.strip(entry.path)}
											onOpen={(target) => setPath(target.path)}
											onExclude={setEntryToExclude}
										/>
									))
								)}
							</div>

							{(hidden || cappedByLimit) && (
								<p className="px-3 py-2 text-xs text-muted-foreground">
									{cappedByLimit &&
										(isComparing
											? `Showing the ${rows.length} biggest changes of ${totalEntries} entries. `
											: `Showing the largest ${rows.length} of ${totalEntries} entries. `)}
									{hidden && (
										<>
											{hidden.count.toLocaleString()} smaller item{hidden.count === 1 ? "" : "s"}{" "}
											(
											<ByteSize bytes={hidden.size} />) were too small to record individually.
										</>
									)}
								</p>
							)}

							<div className="flex items-start gap-2 border-t border-border px-3 py-3 text-xs text-muted-foreground">
								<Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
								<div className="space-y-1">
									<p>
										Read from the snapshot with restic, so these are the snapshot's own contents.
										Sizes are the original file sizes, before deduplication and compression — the
										same thing <span className="font-mono">du</span> reports.
										{repositorySize !== undefined && (
											<>
												{" "}
												The repository itself holds <ByteSize bytes={repositorySize} />.
											</>
										)}
									</p>
									{usageData.meta.skipped > 0 && (
										<p>{usageData.meta.skipped.toLocaleString()} entries could not be read.</p>
									)}
									{diffReady && (
										<>
											<p>
												"New" and "gone" mean the path only appears in one snapshot's recorded
												tree — not necessarily that it was created or deleted.
											</p>
											{(diffReady.meta.current.appliedMinSize > 0 ||
												diffReady.meta.against.appliedMinSize > 0) && (
												<p>
													One of these snapshots pruned entries smaller than a size threshold
													to keep the tree a manageable size, so some of what looks new or
													gone here may have just crossed that threshold.
												</p>
											)}
											{diffReady.directory && !diffReady.directory.existsInAgainst && (
												<p>This folder doesn't exist in the snapshot being compared against.</p>
											)}
										</>
									)}
								</div>
							</div>
						</>
					)}
				</CardContent>
			</Card>

			<ExcludeDialog
				entry={entryToExclude}
				schedule={schedule}
				displayBasePath={effectiveDisplayBasePath}
				onClose={() => setEntryToExclude(null)}
			/>
		</>
	);
};
