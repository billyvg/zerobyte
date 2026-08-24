import { Ban, File as FileIcon, Folder as FolderIcon } from "lucide-react";
import { Button } from "~/client/components/ui/button";
import { ByteSize } from "~/client/components/bytes-size";
import { cn } from "~/client/lib/utils";
import { useTimeFormat } from "~/client/lib/datetime";
import type { SnapshotUsageDiffStatus, SnapshotUsageEntry } from "~/schemas/snapshot-usage";

/** How this entry's size changed against the snapshot it's being compared to. */
export type UsageRowDiff = {
	previousSize: number;
	delta: number;
	status: SnapshotUsageDiffStatus;
};

type Props = {
	entry: SnapshotUsageEntry;
	/** Present while comparing against another snapshot. */
	diff?: UsageRowDiff | null;
	onOpen: (entry: SnapshotUsageEntry) => void;
	onExclude: (entry: SnapshotUsageEntry) => void;
	/** Path to show on hover; falls back to the real path when not relativized. */
	displayPath?: string;
};

const percent = (value: number) => `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;

// formatDateTime doesn't zero-pad the hour (e.g. "1/10/2026, 2:30 PM"), which is
// fine for prose but shifts this right-aligned column out of line whenever the
// hour is a single digit.
const padHour = (formatted: string) => formatted.replace(/\b(\d):(\d{2})\b/, "0$1:$2");

const STATUS_LABEL: Record<SnapshotUsageDiffStatus, string | null> = {
	added: "new",
	removed: "gone",
	changed: null,
	unchanged: null,
};

export const UsageRow = ({ entry, diff, displayPath, onOpen, onExclude }: Props) => {
	const { formatDateTime } = useTimeFormat();
	const isDirectory = entry.type === "dir";
	const shownPath = displayPath ?? entry.path;
	const isRemoved = diff?.status === "removed";
	const grew = diff !== undefined && diff !== null && diff.delta > 0;
	const shrank = diff !== undefined && diff !== null && diff.delta < 0;
	const statusLabel = diff ? STATUS_LABEL[diff.status] : null;

	return (
		<div className="group relative flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-accent/50">
			{/*
			 * The bar is the point of the row: it makes "this one is the problem"
			 * readable before any of the numbers are.
			 */}
			<div
				aria-hidden
				className="absolute inset-y-0 left-0 bg-primary/10 group-hover:bg-primary/15"
				style={{ width: percent(Math.min(1, Math.max(0, entry.shareOfParent))) }}
			/>

			<div className="relative flex min-w-0 flex-1 items-center gap-2">
				{isDirectory ? (
					<FolderIcon className="h-4 w-4 shrink-0 text-strong-accent" />
				) : (
					<FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
				)}

				{isDirectory ? (
					<button
						type="button"
						onClick={() => onOpen(entry)}
						className="truncate text-left text-sm font-medium hover:underline"
						title={shownPath}
					>
						{entry.name}
					</button>
				) : (
					<span className="truncate text-sm" title={shownPath}>
						{entry.name}
					</span>
				)}

				{statusLabel && (
					<span
						className={cn(
							"hidden shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide sm:inline",
							diff?.status === "added"
								? "bg-destructive/10 text-destructive"
								: "bg-success/10 text-success",
						)}
					>
						{statusLabel}
					</span>
				)}

				{isDirectory && entry.fileCount !== undefined && (
					<span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
						{entry.fileCount.toLocaleString()} file{entry.fileCount === 1 ? "" : "s"}
					</span>
				)}
			</div>

			<div className="relative hidden w-40 shrink-0 text-right text-xs text-muted-foreground tabular-nums md:block">
				{entry.maxMtime ? padHour(formatDateTime(entry.maxMtime)) : "—"}
			</div>

			<div className="relative w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
				{isRemoved ? "—" : percent(entry.shareOfParent)}
			</div>

			<div className="relative w-24 shrink-0 text-right text-sm font-medium tabular-nums">
				{isRemoved ? "—" : <ByteSize bytes={entry.size} />}
			</div>

			{diff && (
				<div
					className={cn(
						"relative w-24 shrink-0 text-right text-sm font-medium tabular-nums",
						grew && "text-destructive",
						shrank && "text-success",
					)}
				>
					{diff.delta === 0 ? (
						"—"
					) : (
						<>
							{grew ? "+" : ""}
							<ByteSize bytes={diff.delta} />
						</>
					)}
				</div>
			)}

			<div className="relative flex w-16 shrink-0 items-center justify-end gap-1">
				{!isRemoved && (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2"
						onClick={() => onExclude(entry)}
						aria-label={`Exclude ${entry.path}`}
						title="Exclude from future backups"
					>
						<Ban className="h-3.5 w-3.5" />
					</Button>
				)}
			</div>
		</div>
	);
};
