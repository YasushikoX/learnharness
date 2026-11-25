import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import type { PluginButtonColors as ButtonColors } from "@/src/core"

/**
 * THE BUTTON (UI round 1, 2026-11-25, SPEC §3): one primitive, one grammar.
 * Heights sm 28 / md 32 (default) / lg 36; icon buttons square 28 / 32 / 36; touch screens keep a 44px hit area
 * (lh-touch grows the box on coarse pointers only). Radius 8 (6 for the compact xs/sm sizes).
 * Variants: primary (`default`, solid accent, at most one per region) · secondary (neutral fill) · outline (hairline
 * input border) · ghost (no fill until hover) · destructive (danger text on a neutral fill) · destructiveSolid (the
 * confirm button of a delete dialog only) · link (inline). States: hover one fill step, active one more, no scale
 * except primary (0.98), disabled = muted text at full opacity (solid fills step down to the neutral raised fill; UI
 * round 2: a 45% fade on muted text fell under 3:1), focus-visible a 2px accent ring at 40% with a 1px offset. No shadows.
 * `buttonVariants` is the class helper for elements that cannot be a <Button> (a link, a label).
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap select-none transition-[background-color,color,border-color,opacity,transform] duration-(--lh-duration-hover) ease-(--lh-ease) outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/85 active:scale-[0.98] motion-reduce:active:scale-100 disabled:bg-raised-strong disabled:text-muted-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-raised-strong active:bg-raised-strong disabled:text-muted-foreground",
        outline:
          "border border-input bg-transparent text-foreground hover:bg-raised active:bg-raised-strong disabled:text-muted-foreground",
        ghost:
          "text-foreground hover:bg-raised active:bg-raised-strong disabled:text-muted-foreground",
        destructive:
          "bg-secondary text-destructive hover:bg-raised-strong active:bg-raised-strong disabled:text-muted-foreground",
        destructiveSolid:
          "bg-destructive text-white dark:text-zinc-950 hover:bg-destructive/90 active:bg-destructive/85 disabled:bg-raised-strong disabled:text-muted-foreground",
        link: "h-auto! px-0! text-primary underline-offset-4 hover:underline disabled:text-muted-foreground",
        // Plugin colours own their disabled slots; without them the plain 45% fade stands in.
        custom: "border border-transparent bg-primary text-primary-foreground disabled:opacity-45",
      },
      size: {
        default: "h-8 px-3 has-[>svg]:px-2.5 has-[>[data-slot=button-icon]]:px-2.5",
        xs: "h-6 gap-1 rounded-sm px-2 text-xs has-[>svg]:px-1.5 has-[>[data-slot=button-icon]]:px-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-7 gap-1.5 rounded-sm px-2.5 has-[>svg]:px-2 has-[>[data-slot=button-icon]]:px-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 px-4 has-[>svg]:px-3.5 has-[>[data-slot=button-icon]]:px-3.5",
        icon: "size-8",
        "icon-xs": "size-6 rounded-sm [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-7 rounded-sm [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function customButtonColors(colors?: ButtonColors) {
  const style: React.CSSProperties & Record<`--button-custom-${string}`, string> = {}
  const classes: string[] = []
  const add = (value: string | undefined, variable: `--button-custom-${string}`, className: string) => {
    if (value === undefined) return
    style[variable] = value
    classes.push(className)
  }
  // Keep complete utility names static for Tailwind discovery. Missing slots
  // add no state utility, so each property retains its applicable lower color.
  add(colors?.background, "--button-custom-background", "bg-[color:var(--button-custom-background)]")
  add(colors?.text, "--button-custom-text", "text-[color:var(--button-custom-text)]")
  add(colors?.border, "--button-custom-border", "border-[color:var(--button-custom-border)]")
  add(colors?.hover?.background, "--button-custom-hover-background", "hover:bg-[color:var(--button-custom-hover-background)]")
  add(colors?.hover?.text, "--button-custom-hover-text", "hover:text-[color:var(--button-custom-hover-text)]")
  add(colors?.hover?.border, "--button-custom-hover-border", "hover:border-[color:var(--button-custom-hover-border)]")
  add(colors?.active?.background, "--button-custom-active-background", "active:bg-[color:var(--button-custom-active-background)]")
  add(colors?.active?.text, "--button-custom-active-text", "active:text-[color:var(--button-custom-active-text)]")
  add(colors?.active?.border, "--button-custom-active-border", "active:border-[color:var(--button-custom-active-border)]")
  add(colors?.focusVisible?.background, "--button-custom-focus-visible-background", "focus-visible:bg-[color:var(--button-custom-focus-visible-background)]")
  add(colors?.focusVisible?.text, "--button-custom-focus-visible-text", "focus-visible:text-[color:var(--button-custom-focus-visible-text)]")
  add(colors?.focusVisible?.border, "--button-custom-focus-visible-border", "focus-visible:border-[color:var(--button-custom-focus-visible-border)]")
  add(colors?.focusVisible?.ring, "--button-custom-focus-visible-ring", "focus-visible:ring-[color:var(--button-custom-focus-visible-ring)]")
  add(colors?.disabled?.background, "--button-custom-disabled-background", "disabled:bg-[color:var(--button-custom-disabled-background)]")
  add(colors?.disabled?.text, "--button-custom-disabled-text", "disabled:text-[color:var(--button-custom-disabled-text)]")
  add(colors?.disabled?.border, "--button-custom-disabled-border", "disabled:border-[color:var(--button-custom-disabled-border)]")
  return { style, classes }
}

function Button({
  className,
  colors,
  style,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    colors?: ButtonColors
  }) {
  const Comp = asChild ? Slot.Root : "button"
  const customColors = variant === "custom" ? customButtonColors(colors) : undefined

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size }), customColors?.classes, className)}
      style={customColors ? { ...customColors.style, ...style } : style}
      {...props}
    />
  )
}

export { Button, buttonVariants }
