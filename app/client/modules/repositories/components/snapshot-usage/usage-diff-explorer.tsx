import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowUp, GitCompare, HardDrive, Info } from "lucide-react";
import { getSnapshotUsageDiffOptions, listSnapshotsOptions } from "~/client/api-client/@tanstack/react-query.gen";
import { Card, CardContent, CardHeader, CardTitle } from "~/client/components/ui/card";
import { Button } from "~/client/components/ui/button";
import { ByteSize } from "~/client/components/bytes-size";
import { Skeleton } from "~/client/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/client/components/ui/select";
import { useTimeFormat } from "~/client/lib/datetime";
import { parseError } from "~/client/lib/errors";
import { cn } from "~/client/lib/utils";
import type { SnapshotUsageDiffEntry } from "~/schemas/snapshot-usage";
import { UsageBreadcrumb } from "./usage-breadcrumb";
import { UsageDiffRow } from "./usage-diff-row";

type Props = {
	repositoryId: string;
	snapshotId: string;
};

const UsageDiffPlaceholder = ({ title, message }: { title: string; message: string }) => (
	<Card>
		<CardContent className="flex flex-col items-center justify-center py-12 text-center">
			<HardDrive className="mb-4 h-12 w-12 text-muted-foreground" />
			<p className="font-semibold">{title}</p>
			<p className="mt-2 max-w-lg text-sm text-muted-foreground">{message}</p>
		</CardContent>
	</Card>
);

export const UsageDiffExplorer = ({ repositoryId, snapshotId }: Props) => {
	const [against, setAgainst] = useState<string | undefined>(undefined);
	const [path, setPath] = useState<string | undefined>(undefined);
	const { formatDateTime } = useTimeFormat();

	const { data: snapshots } = useQuery(listSnapshotsOptions({ path: { shortId: repositoryId } }));

	// Newest first, and never the snapshot being viewed — comparing it to itself
	// isn't useful.
	const candidates = useMemo(
		() => (snapshots ?? []).filter((s) => s.short_id !== snapshotId).sort((a, b) => b.time - a.time),
		[snapshots, snapshotId],
	);

	// Default to the snapshot immediately before this one, since "what grew
	// since last time" is the common case the plan calls out.
	const defaultAgainst = useMemo(() => {
		const current = snapshots?.find((s) => s.short_id === snapshotId);
		if (!current) return candidates[0]?.short_id;

		return candidates.find((s) => s.time < current.time)?.short_id ?? candidates[0]?.short_id;
	}, [snapshots, snapshotId, candidates]);

	const selectedAgainst = against ?? defaultAgainst;

	const { data, isLoading, isFetching, error } = useQuery({
		...getSnapshotUsageDiffOptions({
			path: { shortId: repositoryId, snapshotId },
			query: { against: selectedAgainst ?? "", ...(path ? { path } : {}) },
		}),
		enabled: Boolean(selectedAgainst),
		// Keeps the current directory on screen while a new one loads, instead of
		// unmounting it for a skeleton — that swap is what reads as a "flash".
		placeholderData: keepPreviousData,
	});

	const root = data?.status === "ready" ? (data.meta.current.roots[0] ?? data.meta.against.roots[0] ?? "/") : "/";
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

	const picker = (
		<Select
			value={selectedAgainst}
			onValueChange={(value) => {
				setAgainst(value);
				setPath(undefined);
			}}
			disabled={candidates.length === 0}
		>
			<SelectTrigger className="w-full sm:w-64">
				<SelectValue placeholder="Choose a snapshot to compare" />
			</SelectTrigger>
			<SelectContent>
				{candidates.map((candidate) => (
					<SelectItem key={candidate.short_id} value={candidate.short_id}>
						{formatDateTime(candidate.time)} ({candidate.short_id})
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);

	if (!snapshots) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Compare</CardTitle>
				</CardHeader>
				<CardContent className="space-y-2">
					{Array.from({ length: 6 }, (_, index) => (
						<Skeleton key={index} className="h-9 w-full" />
					))}
				</CardContent>
			</Card>
		);
	}

	if (candidates.length === 0) {
		return (
			<UsageDiffPlaceholder
				title="Nothing to compare against"
				message="This is the only snapshot in this repository, so there's nothing to diff it against yet."
			/>
		);
	}

	if (!selectedAgainst) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Compare</CardTitle>
				</CardHeader>
				<CardContent>{picker}</CardContent>
			</Card>
		);
	}

	if (isLoading) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Compare</CardTitle>
					{picker}
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
					<p className="text-destructive">{parseError(error)?.message ?? "Failed to load the comparison"}</p>
				</CardContent>
			</Card>
		);
	}

	if (!data || data.status === "missing") {
		const missing = data?.status === "missing" ? data.missing : "both";
		const message =
			missing === "both"
				? "Neither snapshot has recorded usage. Usage is measured while a backup runs, so snapshots taken before that was enabled, or by a remote agent, won't have it."
				: missing === "current"
					? "This snapshot has no recorded usage to compare from."
					: "The snapshot being compared against has no recorded usage.";

		return (
			<Card>
				<CardHeader>
					<CardTitle>Compare</CardTitle>
					{picker}
				</CardHeader>
				<CardContent>
					<UsageDiffPlaceholder title="Nothing to compare" message={message} />
				</CardContent>
			</Card>
		);
	}

	const { meta, directory, entries, totalEntries } = data;
	const cappedByLimit = totalEntries > entries.length;
	const maxAbsDelta = entries.reduce((max, entry) => Math.max(max, Math.abs(entry.delta)), 0);

	const openEntry = (entry: SnapshotUsageDiffEntry) => setPath(entry.path);

	return (
		<Card className={cn("flex flex-col transition-opacity", isFetching && !isLoading && "opacity-60")}>
			<CardHeader>
				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="min-w-0">
						<CardTitle className="flex items-center gap-2">
							<GitCompare className="h-4 w-4" />
							Compare
						</CardTitle>
						<p className="mt-1 text-sm text-muted-foreground">
							<ByteSize bytes={meta.current.totalSize} /> now vs{" "}
							<ByteSize bytes={meta.against.totalSize} /> in the snapshot compared against, measured{" "}
							{formatDateTime(meta.current.scannedAt)} and {formatDateTime(meta.against.scannedAt)}
						</p>
					</div>
					{parent !== null && (
						<Button variant="outline" size="sm" onClick={() => setPath(parent)}>
							<ArrowUp className="h-4 w-4" />
							Up
						</Button>
					)}
				</div>

				{picker}

				<UsageBreadcrumb root={root} path={currentPath} onNavigate={setPath} />
			</CardHeader>

			<CardContent className="p-0">
				<div className="border-y border-border">
					{entries.length === 0 ? (
						<p className="px-3 py-8 text-center text-sm text-muted-foreground">
							Nothing recorded inside this folder in either snapshot.
						</p>
					) : (
						entries.map((entry) => (
							<UsageDiffRow key={entry.path} entry={entry} maxAbsDelta={maxAbsDelta} onOpen={openEntry} />
						))
					)}
				</div>

				{cappedByLimit && (
					<p className="px-3 py-2 text-xs text-muted-foreground">
						Showing the {entries.length} biggest changes of {totalEntries} entries.
					</p>
				)}

				<div className="flex items-start gap-2 border-t border-border px-3 py-3 text-xs text-muted-foreground">
					<Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
					<div className="space-y-1">
						<p>
							"New" and "gone" mean the path only appears in one snapshot's recorded tree — not
							necessarily that it was created or deleted.
						</p>
						{(meta.current.appliedMinSize > 0 || meta.against.appliedMinSize > 0) && (
							<p>
								One of these snapshots pruned entries smaller than a size threshold to keep the tree a
								manageable size, so some of what looks new or gone here may have just crossed that
								threshold.
							</p>
						)}
						{directory && !directory.existsInAgainst && (
							<p>This folder doesn't exist in the snapshot being compared against.</p>
						)}
						{directory && !directory.existsInCurrent && (
							<p>This folder doesn't exist in the current snapshot.</p>
						)}
					</div>
				</div>
			</CardContent>
		</Card>
	);
};
