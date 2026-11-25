"use client";

import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";

/** The core and controlled plugin pickers share the very same trigger renderer. */
export function ModelPickerPill({ children, ...props }: ComponentProps<"button">) {
	return <button type="button" {...props}
		className="lh-touch flex h-7 items-center gap-1.5 rounded-sm px-2 font-mono text-xs transition-colors duration-(--lh-duration-hover) ease-(--lh-ease) hover:bg-raised">
		<span className="text-card-foreground">{children}</span>
		<ChevronDown aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0 text-muted-foreground" />
	</button>;
}
