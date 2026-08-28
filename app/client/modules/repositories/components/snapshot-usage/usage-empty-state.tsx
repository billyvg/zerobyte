import { HardDrive, Loader2, Search } from "lucide-react";
import { Card, CardContent } from "~/client/components/ui/card";
import { Button } from "~/client/components/ui/button";

type Props = {
	onScan: () => void;
	isStarting: boolean;
};

export const UsageEmptyState = ({ onScan, isStarting }: Props) => (
	<Card>
		<CardContent className="flex flex-col items-center justify-center py-12 text-center">
			<HardDrive className="mb-4 h-12 w-12 text-muted-foreground" />
			<p className="font-semibold">Storage usage has not been measured for this snapshot</p>
			<p className="mt-2 max-w-lg text-sm text-muted-foreground">
				Zerobyte can read the directory sizes straight out of the snapshot with restic. It reads only metadata,
				never file contents, and the result is cached — a snapshot never changes, so this is measured once.
			</p>
			<p className="mt-2 max-w-lg text-sm text-muted-foreground">
				On a repository restic has not read recently this downloads the snapshot's directory metadata, which can
				take a few minutes.
			</p>
			<Button className="mt-6" onClick={onScan} disabled={isStarting} loading={isStarting}>
				<Search className="h-4 w-4" />
				Measure storage usage
			</Button>
		</CardContent>
	</Card>
);

export const UsageScanningState = ({ bytesRead }: { bytesRead?: number }) => (
	<Card>
		<CardContent className="flex flex-col items-center justify-center py-12 text-center">
			<Loader2 className="mb-4 h-12 w-12 animate-spin text-muted-foreground" />
			<p className="font-semibold">Measuring storage usage…</p>
			<p className="mt-2 max-w-lg text-sm text-muted-foreground">
				Reading the snapshot's directory metadata with restic. You can leave this page; the result is cached
				when it finishes.
			</p>
			{bytesRead !== undefined && bytesRead > 0 && (
				<p className="mt-2 text-xs text-muted-foreground tabular-nums">
					{Math.round(bytesRead / 1024).toLocaleString()} KB read
				</p>
			)}
		</CardContent>
	</Card>
);
