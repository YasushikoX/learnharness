"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DIFFICULTIES, difficultyInfo, resolveDifficulty, type ChatSettings, type Difficulty } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { usePopoverDismiss } from "./popover-dismiss.ts";
import { Hint } from "@/components/ui/hint";
import { CONTROL_CLASS, type ControlVariant } from "@/components/control-variant";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { chatSettingsGeneration, fetchChatSettings, updateChatSettings, useChatSettingsSeed } from "@/components/chat-settings-client";

/**
 * The difficulty pill (fork addition, 2026-11-07) — the pace pill's sibling on
 * the composer's edge, for a RUNNING PRACTICE session only (the mirror of
 * PaceControl, which hides for practice):
 *
 *   a pick rewrites the session's record (replace-whole, so the other fields
 *   ride along) and takes effect from the next problem.
 *
 * Difficulty sizes the practice agent's problems; teaching sessions are not
 * sized by it, so the pill hides for them.
 */
type SessionView = { settings?: ChatSettings; kind?: string };

export function DifficultyControl({ chatId, variant = "edge" }: { chatId: string; variant?: ControlVariant }) {
	const seed = useChatSettingsSeed(chatId);
	const [view, setView] = useState<SessionView | undefined>(() =>
		seed ? { settings: seed.settings ?? {}, kind: seed.kind } : undefined,
	);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const read = useCallback(() => {
		const gen = chatSettingsGeneration(chatId);
		fetchChatSettings(chatId)
			.then((b) => {
				if (chatSettingsGeneration(chatId) !== gen) return;
				setView({ settings: b.settings ?? {}, kind: b.kind });
			})
			.catch(() => {});
	}, [chatId]);
	useEffect(() => {
		read();
	}, [read]);
	useSettingsSaved((section) => {
		if (section === "lesson" || section === "models") read();
	});

	// Outside pointerdown, Esc and the Android back close it through the shared popup layer (interaction-layers.tsx).
	usePopoverDismiss(containerRef, open, () => setOpen(false));

	if (view?.kind !== "practice") return null;
	const current = resolveDifficulty(view?.settings);

	const save = async (patch: (current: ChatSettings) => ChatSettings): Promise<boolean> => {
		setError(null);
		const res = await updateChatSettings(chatId, patch);
		if (!res.ok) {
			setError(res.networkError ? "Could not reach the server — try again." : (res.error ?? `difficulty rejected (${res.status})`));
			return false;
		}
		setView((prev) => ({ ...prev, settings: res.settings }));
		notifySettingsSaved("lesson");
		return true;
	};

	const pick = async (difficulty: Difficulty) => {
		if (await save((current) => ({ ...current, difficulty }))) setOpen(false);
	};

	return (
		<div ref={containerRef} className="relative flex items-center" data-testid="difficulty-control">
			<Hint label="Difficulty — how much each problem asks of you" side="bottom">
				<button
					type="button"
					data-testid="stats-difficulty"
					aria-label={`Difficulty: ${difficultyInfo(current).label}`}
					aria-expanded={open}
					onClick={() => {
						setOpen((o) => !o);
						setError(null);
					}}
					className={CONTROL_CLASS[variant]}
				>
					<span className="text-card-foreground">{difficultyInfo(current).short}</span>
					<span aria-hidden className="text-xs text-muted-foreground">▾</span>
				</button>
			</Hint>
			{open && (
				<MenuShell
					anchorRef={containerRef}
					testid="difficulty-menu"
					preferredSide="up"
					menuClass="flex w-72 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					{error && <div className="mb-1.5 text-destructive">{error}</div>}
					{DIFFICULTIES.map((d) => (
						<button
							key={d.id}
							type="button"
							data-testid={`difficulty-option-${d.id}`}
							onClick={() => void pick(d.id)}
							className={`flex items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted ${
								d.id === current ? "text-foreground" : "text-muted-foreground"
							}`}
						>
							<span className="flex flex-col">
								<span>{d.label}</span>
								<span className="text-[11px] text-muted-foreground/70">{d.blurb}</span>
							</span>
							{d.id === current && <span aria-hidden>✓</span>}
						</button>
					))}
					<div className="px-2 pt-1 text-[11px] text-muted-foreground/70">This practice session only — takes effect on the next problem</div>
				</MenuShell>
			)}
		</div>
	);
}
