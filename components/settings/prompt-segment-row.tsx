"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsRow, Toggle } from "./controls";

export function promptSegmentName(path: string): string {
	const name = (path.split("/").at(-1) ?? "").replace(/\.[^.]+$/, "").replace(/^[\d-]+/, "").replace(/-+/g, " ");
	return name.charAt(0).toUpperCase() + name.slice(1);
}

export function PromptSegmentRow({ path, usageHint, hasOverride, enabled, busy, switching, error, onView, onEdit, onToggle }: {
	path: string;
	usageHint?: string;
	hasOverride: boolean;
	enabled: boolean;
	busy: boolean;
	switching: boolean;
	error?: string;
	onView: (row: HTMLDivElement) => void;
	onEdit: (row: HTMLDivElement) => void;
	onToggle: (enabled: boolean) => void;
}) {
	const name = promptSegmentName(path);
	const row = useRef<HTMLDivElement>(null);
	return <div ref={row} role="group" aria-label={name} tabIndex={-1} data-testid={`prompt-segment-${path}`} className="lh-settings-row-group focus-visible:outline-1 focus-visible:outline-ring">
		<SettingsRow label={name} hint={usageHint} testid={`prompt-row-${path}`}>
			<div className="flex flex-wrap items-center justify-end gap-2">
				<Button type="button" variant="ghost" disabled={busy} onClick={() => { if (row.current) onView(row.current); }}>View default</Button>
				<Button type="button" variant="outline" className={cn("w-32", switching && !busy && "disabled:opacity-100")} disabled={busy || switching} onClick={() => { if (row.current) onEdit(row.current); }}>
					{hasOverride ? "Edit override" : "+ Add override"}
				</Button>
				<div className="flex items-center justify-end gap-2">
					<span className="w-28 text-right text-xs text-muted-foreground">In use: <span className="text-foreground">{enabled ? "Your version" : "Default"}</span></span>
					<span className={cn("flex", !hasOverride && "opacity-40")}>
						<Toggle label={`Use your override for ${name}`} title="Use your override instead of the default" checked={enabled} disabled={!hasOverride || busy || switching} onChange={onToggle} />
					</span>
				</div>
			</div>
		</SettingsRow>
		{error && <p role="alert" className="px-4 pb-2 text-sm text-error">{error}</p>}
	</div>;
}
