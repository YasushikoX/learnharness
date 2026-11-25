"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CLAUDE_CODE_PROVIDER, sessionCacheHitRate, subscriptionLabels, subscriptionLabel, type cliContextWindowOf, type SessionPricing, type TurnUsage } from "@/src/core";
import { formatTokens, formatUsd, planCostLabel, prettyModel } from "@/components/usage-format";
import { ModelControlView, catalogLimits, useModelCatalog, useModelSelection, type ModelSelection } from "@/components/model-picker";
import { PlanUsage } from "@/components/plan-usage";
import { MenuShell } from "@/components/menu-shell";
import { useInteractionLayers } from "@/components/interaction-layers";

export function formatContextMeasurement(tokens: number | null, limit: number | null): string {
	const numerator = tokens === null ? "?" : formatTokens(tokens);
	return limit === null ? numerator : `${numerator} / ${formatTokens(limit)}`;
}

/** CLI aliases have no global catalog limit: only this session's matching
 * response can supply a denominator. Other providers keep their catalog join. */
export function contextLimitForModel(model: string | undefined, limits: ReadonlyMap<string, number> | undefined,
	cliWindow: ReturnType<typeof cliContextWindowOf> = null): number | null {
	if (!model) return null;
	if (model.startsWith(`${CLAUDE_CODE_PROVIDER}:`)) return cliWindow?.model === model ? cliWindow.tokens : null;
	return limits?.get(model) ?? null;
}

/** The session's numbers, as the stats cluster reads them. */
export interface SessionStatsProps {
	turns: TurnUsage[];
	contextTokens?: number | null;
	cliContextWindow?: ReturnType<typeof cliContextWindowOf>;
	pricing?: SessionPricing;
	/** The bound session (per-session models, owner 2026-09-28): present
	 *  in a session — the model control binds THE SESSION'S own record;
	 *  absent on the draft surfaces, where it binds the strong slot (the
	 *  new-session default). */
	chatId?: string;
}

/**
 * The session stats + model cluster (wave 4 observability; owner 2026-11-25:
 * "the model selection should go to the left of the microphone button. It
 * wastes so much space by pushing that entire window up"). It rides the
 * composer toolbar (composer-edge.tsx), immediately left of the mic:
 * context window + session cost (+ the Claude plan's usage) as quiet 12px
 * text, then the model + thinking control. Clicking the summary opens the
 * per-turn detail popover. The numbers hide first when the toolbar is
 * narrow (a container query on the edge row), so the row never wraps.
 *
 *  Pre-chat views (home, /chat/new) render NO numbers at all (owner,
 *  wave 7 sweep: a "— · —" summary over an empty popover is pure noise).
 *
 * Spending arrives already priced by the server through Pi's catalog and
 * calculator. Missing cost stays "—", never fake zero. Context is a separate
 * completed-conversation measurement, never a money-log/summarizer fold or
 * transcript estimate. Its denominator follows the selected model, from the
 * catalog or the session's CLI report; model changes preserve the numerator.
 * Successful compaction clears the numerator and any old CLI report.
 *
 * The model selection is passed in: a session view keeps ONE selection alive
 * while it is open (the context limit and the sketch-answer gate read it,
 * also while a plugin owns the dock and no toolbar shows) — see StatsBar for
 * the self-contained form.
 */
export function ToolbarStats({ selection, ...stats }: SessionStatsProps & { selection: ModelSelection }) {
	return (
		<div data-testid="stats-bar" className="flex min-w-0 items-center justify-end gap-1">
			<SessionStats {...stats} model={selection.model} />
			<ModelControlView selection={selection} variant="edge" />
		</div>
	);
}

/** The self-contained cluster: its own model selection, reported through
 *  onModelChange (the session's effective model, "provider:id"). */
export function StatsBar({ onModelChange, ...props }: SessionStatsProps & { onModelChange?: (model: string | undefined) => void }) {
	return <ToolbarStats {...props} selection={useModelSelection(props.chatId, onModelChange)} />;
}

/** The context · cost summary and the plan usage; nothing when unknown. */
export function SessionStats({
	turns,
	contextTokens = null,
	cliContextWindow = null,
	pricing,
	chatId,
	model,
}: SessionStatsProps & { model: string | undefined }) {
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLDivElement>(null);
	const interactions = useInteractionLayers();
	// The picker reports its effective selection. CLI windows are session-
	// scoped; unknown metadata always means usage-only, never a guessed maximum.
	const { catalog } = useModelCatalog();
	const limits = useMemo(() => (catalog ? catalogLimits(catalog) : undefined), [catalog]);
	const limit = contextLimitForModel(model, limits, cliContextWindow);
	const contextLabel = formatContextMeasurement(contextTokens, limit);
	const cacheHitRate = useMemo(() => sessionCacheHitRate({ turns }), [turns]);
	const { cost = 0, unpriced = turns.length, subscription = 0 } = pricing ?? {};
	// Honest cost: show dollars only when at least one turn priced;
	// otherwise "—" (never a fake $0.0000).
	const pricedCount = turns.length - unpriced - subscription;
	const providers = pricing?.subscriptionProviders ?? subscriptionLabels(turns.map((turn) => turn.model));
	const cliBilled = turns.some((turn) => turn.model.startsWith(`${CLAUDE_CODE_PROVIDER}:`));
	const costLabel = planCostLabel(pricedCount > 0 ? cost : null, cliBilled ? [...providers, "CLI"] : providers);
	const contextKnown = contextTokens !== null;
	const costKnown = costLabel !== "—";
	const hasSession = Boolean(chatId || turns.length > 0);
	const summaryShown = hasSession && (contextKnown || costKnown);

	// Same dropdown discipline as the model control (owner, df4433f treatment,
	// stats round 1): close on any pointerdown outside the summary or on Escape.
	// The popover is portaled (MenuShell) out of the composer shell's clip, so
	// its own surface is carved out of "outside".
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const t = e.target;
			if (!(t instanceof Node)) return;
			if (anchorRef.current?.contains(t)) return;
			if (t instanceof Element && t.closest('[data-testid="stats-detail"]')) return;
			const top = interactions.getTopLayer();
			if (top?.kind === "popup" && top.anchorRef?.current !== anchorRef.current) return;
			setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open, interactions]);
	useEffect(() => {
		if (!summaryShown) setOpen(false);
	}, [summaryShown]);

	return (
		// The numbers are the first thing to go when the toolbar is narrow
		// (@container on the edge row): the model and the mic keep their room.
		<div data-testid="stats-numbers" className="hidden shrink-0 items-center gap-1.5 pr-1 text-xs empty:hidden! whitespace-nowrap text-muted-foreground @[38rem]:flex">
			{/* The summary — only once a session exists (turns). Pre-chat
			    renders nothing (see the header). */}
			{summaryShown && (
				<div ref={anchorRef} className="flex items-center">
					{/* No tooltip — the numbers describe themselves and the popover
					    speaks on click (owner, subtlety round 2026-09-25). */}
					<button
						type="button"
						onClick={() => setOpen((o) => !o)}
						aria-expanded={open}
						data-testid="stats-summary"
						className="flex h-7 items-center gap-1.5 rounded-sm px-1 tabular-nums transition-colors hover:text-foreground"
					>
						{/* UI round 2: an unknown part is left out ("? / 200k · —" was noise); the popover still lists both. */}
						{contextKnown && (
							<span data-testid="stats-context">
								{contextLabel}
							</span>
						)}
						{contextKnown && costKnown && <span aria-hidden>·</span>}
						{costKnown && <span data-testid="stats-cost">{costLabel}</span>}
					</button>
					{open && (
						<MenuShell
							anchorRef={anchorRef}
							testid="stats-detail"
							preferredSide="up"
							align="left"
							onClose={() => { setOpen(false); return "closed"; }}
							menuClass="w-72 lh-popover p-3 text-xs"
						>
							<div className="mb-2 lh-eyebrow text-muted-foreground">
								Session stats
							</div>
							<div className="flex flex-col gap-1 text-muted-foreground">
								<div className="flex justify-between gap-2">
									<span>Context (last call)</span>
									<span className="tabular-nums text-card-foreground">
										{contextLabel}
									</span>
								</div>
								{model?.startsWith(`${CLAUDE_CODE_PROVIDER}:`) && (
									<p>Window reported by Claude Code; may be lower for auto-compaction.</p>
								)}
								<div className="flex justify-between gap-2">
									<span>{subscription ? "Usage" : "Total cost"}</span>
									<span className="tabular-nums text-card-foreground">{costLabel}</span>
								</div>
								{cacheHitRate !== null && (
									<div data-testid="stats-cache-hit-rate" className="flex justify-between gap-2">
										<span>Cache hit rate</span>
										<span className="tabular-nums text-card-foreground">{(cacheHitRate * 100).toFixed(1)}%</span>
									</div>
								)}
								{providers.includes("ChatGPT") && <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer" className="underline underline-offset-2">Manage ChatGPT usage</a>}
								{unpriced > 0 && (
									<div className="flex justify-between gap-2">
										<span>Unpriced turns</span>
										<span className="tabular-nums text-card-foreground">{unpriced}</span>
									</div>
								)}
							</div>
							{turns.length > 0 && (
								<>
									<div className="mb-1 mt-2.5 border-t pt-2 lh-eyebrow text-muted-foreground">
										Turns
									</div>
									<ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
										{turns.map((turn, i) => {
											const c = pricing?.turnCosts[turn.id] ?? null;
											return (
												<li key={`${turn.messageId}-${i}`} className="flex items-center justify-between gap-2">
													<span className="truncate text-muted-foreground">
														#{i + 1} · {prettyModel(turn.model, true)}
													</span>
													<span className="flex shrink-0 items-center gap-2 tabular-nums text-card-foreground">
														<span className="text-muted-foreground">{turn.steps.length} steps</span>
														<span>{turn.model.startsWith(`${CLAUDE_CODE_PROVIDER}:`) ? "CLI" : subscriptionLabel(turn.model) ?? (c === null ? "—" : formatUsd(c))}</span>
													</span>
												</li>
											);
										})}
									</ul>
								</>
							)}
						</MenuShell>
					)}
				</div>
			)}
			{/* The Claude plan's usage (fork addition) — one more quiet number,
			    "· plan 34%" after the summary; hidden off Claude Code. */}
			<PlanUsage variant="text" separated={summaryShown} />
		</div>
	);
}
