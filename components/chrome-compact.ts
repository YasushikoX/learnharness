/**
 * The graph bar's narrow form (owner, 2026-11-06: with a filled graph the bar ran off a phone's left edge, the search box under
 * the sidebar toggle). The bar's own area is a width container (graph-view.tsx, `@container`); below 34rem of it the text
 * buttons (Chains, Extract files…) become icon-only squares and the search field keeps the room that is left. Outside such a
 * container (another host, a test render) the query never matches, so the labels simply stay.
 *
 * The class names are literal strings on purpose: Tailwind finds them by scanning the source.
 */

/** On the button: a square (the 32px control height) instead of a padded label. */
export const COMPACT_BUTTON = "@max-[34rem]:w-8 @max-[34rem]:justify-center @max-[34rem]:gap-0 @max-[34rem]:px-0";

/** One graph-bar control (UI round 2): a flat 32px hairline control, radius 8, translucent surface over the canvas. No
 *  shadow and no outer capsule: the same grammar as the other toolbars. */
export const GRAPH_TOOL = "h-8 rounded-md border border-border bg-card/90 backdrop-blur";

/** A text/icon button in the graph bar (on top of GRAPH_TOOL). */
export const GRAPH_TOOL_BUTTON = "flex items-center gap-1.5 px-2.5 text-chrome text-muted-foreground transition-colors hover:bg-raised hover:text-foreground";

/** On the label span: gone when narrow (the button's aria-label carries the name). */
export const COMPACT_LABEL = "@max-[34rem]:hidden";
