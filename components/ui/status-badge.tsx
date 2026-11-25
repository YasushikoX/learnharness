import { cn } from "@/lib/utils";

/** Plain-text, noninteractive badge; callers supply any meaning and color. UI round 1 (SPEC §7): a 12px sentence-case
 *  chip on the 6px radius, no uppercase mono. */
export function StatusBadge({ text, color }: { text: string; color?: string }) {
	return (
		<span
			data-slot="status-badge"
			className={cn(
				"rounded-sm px-1.5 py-0.5 text-xs font-medium",
				color === undefined && "bg-raised text-muted-foreground",
			)}
			style={color === undefined ? undefined : {
				color,
				backgroundColor: `color-mix(in oklab, ${color} 15%, transparent)`,
			}}
		>
			{text}
		</span>
	);
}
