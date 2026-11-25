import * as React from "react"

import { cn } from "@/lib/utils"

/** The field look (UI round 1, SPEC §3): 32px, radius 8, a 1px input border, the surface fill; focus = the accent
 *  border + a 3px ring at 20%. Shared with Textarea and the native select (components/settings/controls.tsx). */
export const FIELD_CLASS =
  "rounded-md border border-input bg-card text-sm text-foreground transition-[border-color,box-shadow] duration-(--lh-duration-hover) ease-(--lh-ease) outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-destructive/20"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        FIELD_CLASS,
        "h-8 w-full min-w-0 px-2.5 py-1 selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Input }
