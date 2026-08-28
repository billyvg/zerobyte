import { useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUp, Info } from "lucide-react";
import { toast } from "sonner";
import { isPathWithin, normalizeAbsolutePath } from "@zerobyte/core/utils";
import { getSnapshotUsageOptions, scanSnapshotUsageMutation } from "~/client/api-client/@tanstack/react-query.gen";
import { Card, CardContent, CardHeader, CardTitle } from "~/client/components/ui/card";
import { Button } from "~/client/components/ui/button";
import { ByteSize } from "~/client/components/bytes-size";
import { Skeleton } from "~/client/components/ui/skeleton";
import { useTimeFormat } from "~/client/lib/datetime";
import { parseError } from "~/client/lib/errors";
import { cn } from "~/client/lib/utils";
import { createPathPrefixFns } from "~/client/lib/volume-path";
import type { SnapshotUsageEntry } from "~/schemas/snapshot-usage";
import { UsageRow } from "./usage-row";
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

export const UsageExplorer = ({ repositoryId, snapshotId, schedule, repositorySize, displayBasePath }: Props) => {
	const [path, setPath] = useState<string | undefined>(undefined);
	const [entryToExclude, setEntryToExclude] = useState<SnapshotUsageEntry | null>(null);
	const { formatDateTime } = useTimeFormat();

	const { data, isLoading, isFetching, error } = useQuery({
		...getSnapshotUsageOptions({
			path: { shortId: repositoryId, snapshotId },
			query: path ? { path } : {},
		}),
		// Keeps the current directory on screen while a new one loads, instead of
		// unmounting it for a skeleton — that swap is what reads as a "flash".
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

	const root = data?.status === "ready" ? (data.meta.roots[0] ?? "/") : "/";
	// Prefer the path just navigated to over `data.path`, which can still be the
	// previous directory's while its own fetch is in flight (see placeholderData
	// above) — otherwise the breadcrumb would lag a step behind the click.
	const currentPath = path ?? (data?.status === "ready" ? data.path : "/");

	const parent = useMemo(() => {
		if (currentPath === root) return null;

		const index = currentPath.lastIndexOf("/");
		if (index <= 0) return "/";
		const candidate = currentPath.slice(0, index);
		return candidate.length >= root.length ? candidate : root;
	}, [currentPath, root]);

	// Only relativize against the volume's mount path when it actually contains
	// this tree — otherwise fall back to showing the real path as-is.
	const normalizedDisplayBasePath = normalizeAbsolutePath(displayBasePath ?? "/");
	const effectiveDisplayBasePath = isPathWithin(normalizedDisplayBasePath, root) ? normalizedDisplayBasePath : "/";
	const displayPathFns = useMemo(() => createPathPrefixFns(effectiveDisplayBasePath), [effectiveDisplayBasePath]);

	if (isLoading) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Usage</CardTitle>
				</CardHeader>
				<CardContent className="space-y-2">
					{Array.from({ length: 6 }, (_, index) => (
						<Skeleton key={index} className="h-9 w-full" />
					))}
				</CardContent>
			</Card>
		);
	}

	if (error) {
		return (
			<Card>
				<CardContent className="py-12 text-center">
					<p className="text-destructive">{parseError(error)?.message ?? "Failed to load usage"}</p>
				</CardContent>
			</Card>
		);
	}

	if (!data || data.status === "missing") {
		return (
			<UsageEmptyState
				isStarting={startScan.isPending}
				onScan={() => startScan.mutate({ path: { shortId: repositoryId, snapshotId } })}
			/>
		);
	}

	if (data.status === "scanning") {
		return <UsageScanningState />;
	}

	const { meta, directory, entries, totalEntries } = data;
	const hidden = directory?.truncatedChildren;
	const cappedByLimit = totalEntries > entries.length;

	return (
		<>
			<Card className={cn("flex flex-col transition-opacity", isFetching && !isLoading && "opacity-60")}>
				<CardHeader>
					<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div className="min-w-0">
							<CardTitle>Usage</CardTitle>
							<p className="mt-1 text-sm text-muted-foreground">
								<ByteSize bytes={meta.totalSize} /> across {meta.fileCount.toLocaleString()} files,
								measured {formatDateTime(meta.scannedAt)}
							</p>
						</div>
						{parent !== null && (
							<Button variant="outline" size="sm" onClick={() => setPath(parent)}>
								<ArrowUp className="h-4 w-4" />
								Up
							</Button>
						)}
					</div>

					<UsageBreadcrumb
						root={displayPathFns.strip(root)}
						path={displayPathFns.strip(currentPath)}
						onNavigate={(displayPath) => setPath(displayPathFns.add(displayPath))}
					/>
				</CardHeader>

				<CardContent className="p-0">
					<div className="border-y border-border">
						{entries.length === 0 ? (
							<p className="px-3 py-8 text-center text-sm text-muted-foreground">
								Nothing recorded inside this folder.
							</p>
						) : (
							entries.map((entry) => (
								<UsageRow
									key={entry.path}
									entry={entry}
									displayPath={displayPathFns.strip(entry.path)}
									onOpen={(target) => setPath(target.path)}
									onExclude={setEntryToExclude}
								/>
							))
						)}
					</div>

					{(hidden || cappedByLimit) && (
						<p className="px-3 py-2 text-xs text-muted-foreground">
							{cappedByLimit && `Showing the largest ${entries.length} of ${totalEntries} entries. `}
							{hidden && (
								<>
									{hidden.count.toLocaleString()} smaller item{hidden.count === 1 ? "" : "s"} (
									<ByteSize bytes={hidden.size} />) were too small to record individually.
								</>
							)}
						</p>
					)}

					<div className="flex items-start gap-2 border-t border-border px-3 py-3 text-xs text-muted-foreground">
						<Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
						<div className="space-y-1">
							<p>
								Read from the snapshot with restic, so these are the snapshot's own contents. Sizes are
								the original file sizes, before deduplication and compression — the same thing{" "}
								<span className="font-mono">du</span> reports.
								{repositorySize !== undefined && (
									<>
										{" "}
										The repository itself holds <ByteSize bytes={repositorySize} />.
									</>
								)}
							</p>
							{meta.skipped > 0 && <p>{meta.skipped.toLocaleString()} entries could not be read.</p>}
						</div>
					</div>
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
