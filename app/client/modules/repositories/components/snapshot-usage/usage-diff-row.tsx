import { ArrowRight, File as FileIcon, Folder as FolderIcon } from "lucide-react";
import { ByteSize } from "~/client/components/bytes-size";
import { cn } from "~/client/lib/utils";
import type { SnapshotUsageDiffEntry } from "~/schemas/snapshot-usage";

type Props = {
	entry: SnapshotUsageDiffEntry;
	/** Largest |delta| among the currently visible rows, for the weight bar. */
	maxAbsDelta: number;
	onOpen: (entry: SnapshotUsageDiffEntry) => void;
};

const STATUS_LABEL: Record<SnapshotUsageDiffEntry["status"], string | null> = {
	added: "new",
	removed: "gone",
	changed: null,
	unchanged: null,
};

export const UsageDiffRow = ({ entry, maxAbsDelta, onOpen }: Props) => {
	const isDirectory = entry.type === "dir";
	const weight = maxAbsDelta > 0 ? Math.min(1, Math.abs(entry.delta) / maxAbsDelta) : 0;
	const grew = entry.delta > 0;
	const shrank = entry.delta < 0;
	const statusLabel = STATUS_LABEL[entry.status];

	return (
		<div
			className={cn(
				"group relative flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-accent/50",
				entry.status === "unchanged" && "opacity-60",
			)}
		>
			<div
				aria-hidden
				className={cn(
					"absolute inset-y-0 left-0",
					grew
						? "bg-destructive/10 group-hover:bg-destructive/15"
						: "bg-success/10 group-hover:bg-success/15",
				)}
				style={{ width: `${weight * 100}%` }}
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
						title={entry.path}
					>
						{entry.name}
					</button>
				) : (
					<span className="truncate text-sm" title={entry.path}>
						{entry.name}
					</span>
				)}

				{statusLabel && (
					<span
						className={cn(
							"hidden shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide sm:inline",
							entry.status === "added"
								? "bg-destructive/10 text-destructive"
								: "bg-success/10 text-success",
						)}
					>
						{statusLabel}
					</span>
				)}
			</div>

			<div className="relative hidden w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums md:block">
				{entry.status === "added" ? "—" : <ByteSize bytes={entry.againstSize} />}
			</div>

			<ArrowRight className="relative hidden h-3 w-3 shrink-0 text-muted-foreground md:block" aria-hidden />

			<div className="relative w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
				{entry.status === "removed" ? "—" : <ByteSize bytes={entry.currentSize} />}
			</div>

			<div
				className={cn(
					"relative w-28 shrink-0 text-right text-sm font-medium tabular-nums",
					grew && "text-destructive",
					shrank && "text-success",
				)}
			>
				{entry.delta === 0 ? (
					"—"
				) : (
					<>
						{grew ? "+" : ""}
						<ByteSize bytes={entry.delta} />
					</>
				)}
			</div>
		</div>
	);
};
