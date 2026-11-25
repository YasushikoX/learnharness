"use client";
/**
 * THE THEME PICKER (theme wave, 2026-11-04): a grid of theme cards — the
 * presets, then the imported customs, then the dashed "Import JSON" card —
 * under a header that names the active theme and offers "Export JSON".
 *
 * Each card previews its theme with literal colors (never the page's live
 * tokens): an "Aa ai" sample on the theme background (text + accent ink)
 * and four dots — surface, accent, error, success. Picking a card only
 * changes `appearance.theme`; overrides ride along untouched. Imports POST
 * the file's JSON to /api/themes (the server validates; its error shows in
 * the import card). Export downloads the ACTIVE theme with every override
 * applied — re-importing it reproduces what is on screen.
 */

import { useRef, useState } from "react";
import { CheckIcon, DownloadIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DEFAULT_THEME_ID, WARM_BRASS_THEME_ID, exportThemeFile, type AppearanceSettings, type Theme } from "@/src/core";

const FIRST_THEMES = ["light", DEFAULT_THEME_ID, WARM_BRASS_THEME_ID];

function Dot({ color, edge }: { color: string; edge?: string }) {
	return (
		<span
			aria-hidden
			className="size-3 rounded-full max-sm:size-2"
			style={{ background: color, ...(edge ? { border: `1px solid ${edge}` } : {}) }}
		/>
	);
}

/** The literal-color miniature: never reads the page tokens. */
function Preview({ theme }: { theme: Theme }) {
	const c = theme.colors;
	return (
		<span
			aria-hidden
			className="flex h-10 w-full items-center justify-between gap-2 rounded-md border px-2.5"
			style={{ background: c.background, borderColor: c.border }}
		>
			<span className="font-prose text-xl font-semibold" style={{ color: c.text }}>
				Aa <i className="font-normal" style={{ color: c.accent }}>ai</i>
			</span>
			<span className="flex gap-1">
				<Dot color={c.surface} edge={c.border} />
				<Dot color={c.accent} />
				<Dot color={c.error} />
				<Dot color={c.success} />
			</span>
		</span>
	);
}

/** Save a JSON file through a transient object URL (browser + Electron). */
function downloadJson(filename: string, data: unknown) {
	const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, "\t")}\n`], { type: "application/json" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

/** The Theme row of Settings → Appearance (see the file header). */
export function ThemeCards({
	themes,
	active,
	appearance,
	onSelect,
	onRemoved,
	onImported,
}: {
	/** Presets, then customs (the provider's catalog). */
	themes: readonly Theme[];
	/** The active theme — its card is pressed. */
	active: Theme;
	/** The record delta — the export applies its overrides. */
	appearance: AppearanceSettings | undefined;
	onSelect: (id: string) => void;
	/** After a successful DELETE (the catalog must be re-read). */
	onRemoved: (theme: Theme) => void;
	/** After a successful import (the catalog must be re-read). */
	onImported: (theme: Theme) => void;
}) {
	const fileRef = useRef<HTMLInputElement>(null);
	const [importError, setImportError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const orderedThemes = [
		...FIRST_THEMES.flatMap(id => themes.filter(theme => theme.id === id)),
		...themes.filter(theme => !FIRST_THEMES.includes(theme.id)),
	];

	const importFile = async (file: File) => {
		setImportError(null);
		let body: unknown;
		try {
			body = JSON.parse(await file.text());
		} catch {
			setImportError(`${file.name} is not valid JSON`);
			return;
		}
		setBusy(true);
		try {
			const res = await fetch("/api/themes", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const out = (await res.json().catch(() => ({}))) as { theme?: Theme; error?: string };
			if (!res.ok || !out.theme) {
				setImportError(out.error ?? `import failed (${res.status})`);
				return;
			}
			onImported(out.theme);
		} catch {
			setImportError("import failed (network)");
		} finally {
			setBusy(false);
		}
	};

	const remove = async (theme: Theme) => {
		const res = await fetch(`/api/themes/${encodeURIComponent(theme.id)}`, { method: "DELETE" }).catch(() => null);
		if (res?.ok) onRemoved(theme);
	};

	return (
		<div data-testid="row-theme" className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<h3 className="lh-section-title">Theme</h3>
					<span data-testid="theme-hint" className="block text-sm/5 text-muted-foreground">
						{active.name} selected
					</span>
				</div>
				<Button
					type="button"
					variant="outline"
					data-testid="theme-export"
					onClick={() => downloadJson(`${active.id}.json`, exportThemeFile(active, appearance))}
				>
					<DownloadIcon aria-hidden strokeWidth={1.75} />
					Export JSON
				</Button>
			</div>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
				{orderedThemes.map((theme) => {
					const selected = theme.id === active.id;
					return (
						<div key={theme.id} className="relative min-w-0">
							<Button
								type="button"
								variant="ghost"
								data-testid={`theme-card-${theme.id}`}
								aria-pressed={selected}
								onClick={() => onSelect(theme.id)}
								className={cn(
									"h-full w-full flex-col items-stretch justify-start gap-2 rounded-lg border border-border bg-card p-2 text-left",
									selected && "ring-2 ring-(--lh-accent)",
								)}
							>
								<Preview theme={theme} />
								<span className={cn("flex min-h-6 items-center justify-between gap-2", !theme.builtin && "pr-8")}>
									<span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
										{selected && <CheckIcon aria-hidden className="size-3.5 text-ring" strokeWidth={2} />}
										<span className="truncate">{theme.name}</span>
									</span>
									<span className="shrink-0 text-xs font-normal text-muted-foreground max-sm:hidden">
										{theme.builtin ? theme.mode : "custom"}
									</span>
								</span>
							</Button>
							{!theme.builtin && (
								<Button
									type="button"
									variant="ghost"
									size="icon"
									aria-label={`Remove ${theme.name}`}
									data-testid={`theme-remove-${theme.id}`}
									onClick={() => void remove(theme)}
									className="absolute right-1 bottom-1 text-destructive"
								>
									<Trash2Icon aria-hidden strokeWidth={1.75} />
								</Button>
							)}
						</div>
					);
				})}
				<div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card p-2">
					<Button
						type="button"
						variant="outline"
						data-testid="theme-import"
						disabled={busy}
						onClick={() => fileRef.current?.click()}
					>
						<UploadIcon aria-hidden strokeWidth={1.75} /> Import JSON
					</Button>
					{importError && <p role="alert" data-testid="theme-import-error" className="break-all text-center text-xs text-error">{importError}</p>}
				</div>
				<input
					ref={fileRef}
					type="file"
					accept=".json,application/json"
					hidden
					data-testid="theme-import-file"
					onChange={(e) => {
						const file = e.target.files?.[0];
						e.target.value = ""; // the same file can be picked again
						if (file) void importFile(file);
					}}
				/>
			</div>
		</div>
	);
}
