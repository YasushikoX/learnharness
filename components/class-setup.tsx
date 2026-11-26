"use client";

import { CheckIcon, Loader2Icon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { FileDropZone } from "@/components/class-files";
import type { MaterialsApi } from "@/components/use-materials";
import { cn } from "@/lib/utils";

/**
 * The new / empty class's setup (UI class page, 2026-11-25; owner: an empty class was "a stack of disabled controls").
 * One card in the center: the editable class name, then three steps that tick off as they complete — 1 add your class
 * files (a large drop zone, the same upload path as the side panel), 2 draft the skill map (once a file has been read),
 * 3 start learning (once the map exists). A step that cannot start yet shows only its title, never a disabled button.
 */

export type SetupStepId = "files" | "map" | "learn";

/** Where the skill map step stands. */
export type MapStepState = "no-files" | "reading" | "ready" | "drafting" | "review" | "error" | "done";

export interface SetupStep {
	id: SetupStepId;
	title: string;
	done: boolean;
	/** Its action can run now. */
	enabled: boolean;
	/** The first step not done: the one that is open. */
	current: boolean;
}

export interface SetupInput {
	materialCount: number;
	/** Files still being read. */
	reading: number;
	hasSkills: boolean;
	hasDraft: boolean;
	drafting: boolean;
	courseError?: string;
}

/** The skill map step's state. Pure. */
export function mapStepState(i: SetupInput): MapStepState {
	if (i.hasSkills) return "done";
	if (i.drafting) return "drafting";
	if (i.hasDraft) return "review";
	if (i.materialCount === 0) return "no-files";
	if (i.courseError) return "error";
	if (i.reading >= i.materialCount) return "reading";
	return "ready";
}

/** The three steps for a class's state. Pure — exported for tests. */
export function setupSteps(i: SetupInput): SetupStep[] {
	const map = mapStepState(i);
	const steps: Omit<SetupStep, "current">[] = [
		{ id: "files", title: "Add your class files", done: i.materialCount > 0 || i.hasSkills, enabled: true },
		{ id: "map", title: "Draft the skill map", done: map === "done", enabled: map === "ready" || map === "error" },
		{ id: "learn", title: "Start learning", done: false, enabled: i.hasSkills },
	];
	const current = steps.findIndex((s) => !s.done);
	return steps.map((s, n) => ({ ...s, current: n === current }));
}

/** "1 file", "3 files · reading 1". Pure. */
export function filesSummary(count: number, reading: number): string {
	const files = count === 1 ? "1 file" : `${count} files`;
	return reading > 0 ? `${files} · reading ${reading}` : files;
}

function StepMark({ n, done, current }: { n: number; done: boolean; current: boolean }) {
	return (
		<span
			aria-hidden
			className={cn(
				"flex size-6 shrink-0 items-center justify-center rounded-full text-meta font-semibold tabular-nums",
				done ? "bg-success text-white" : current ? "bg-foreground text-background" : "border border-input text-muted-foreground",
			)}
		>
			{done ? <CheckIcon className="size-3.5" strokeWidth={2.5} /> : n}
		</span>
	);
}

const PRIMARY = buttonVariants();

export function ClassSetup({
	title,
	files,
	materialCount: countProp = 0,
	dropping = false,
	hasSkills,
	hasDraft,
	drafting,
	courseError,
	busy,
	onDraft,
	onLearn,
}: {
	/** The editable class name (the page's H1). */
	title: React.ReactNode;
	/** The class's files (the page's useMaterials); absent in a bare render, which then reads `materialCount`. */
	files?: MaterialsApi;
	materialCount?: number;
	/** A file drag is over the page: the drop zone shows it is the target. */
	dropping?: boolean;
	hasSkills: boolean;
	hasDraft: boolean;
	drafting: boolean;
	courseError?: string;
	busy: boolean;
	onDraft: () => void;
	/** Start the first lesson. */
	onLearn?: () => void;
}) {
	const materialCount = files ? files.materials.length : countProp;
	const reading = files?.reading ?? 0;
	const input = { materialCount, reading, hasSkills, hasDraft, drafting, courseError };
	const steps = setupSteps(input);
	const map = mapStepState(input);
	const body = (step: SetupStep): React.ReactNode => {
		if (step.id === "files") {
			if (!step.done) return files ? <FileDropZone files={files} dropping={dropping} /> : null;
			return null;
		}
		if (step.id === "map") {
			if (map === "drafting")
				return (
					<p className="flex items-center gap-1.5 text-chrome text-muted-foreground" data-testid="setup-drafting">
						<Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden />
						Drafting the skill map…
					</p>
				);
			if (map === "review") return <p className="text-chrome text-muted-foreground">Review the draft below, then approve it.</p>;
			if (map === "reading") return <p className="text-chrome text-muted-foreground">Waiting for the files to be read…</p>;
			if (map === "ready" || map === "error")
				return (
					<div className="space-y-2">
						{map === "error" && (
							<p className="text-chrome text-error" data-testid="setup-error">
								Drafting failed: {courseError}
							</p>
						)}
						<button type="button" className={PRIMARY} disabled={busy} data-testid="setup-draft" onClick={onDraft}>
							{map === "error" ? "Try again" : "Draft skill map"}
						</button>
					</div>
				);
			return null;
		}
		return step.enabled ? (
			<button type="button" className={PRIMARY} disabled={busy || !onLearn} data-testid="setup-learn" onClick={onLearn}>
				Start learning
			</button>
		) : null;
	};
	return (
		<section data-testid="class-setup" aria-label="Set up this class" className="rounded-lg border border-border bg-card p-6">
			{title}
			<ol className="mt-5 space-y-1" data-testid="class-setup-steps">
				{steps.map((step, n) => {
					const content = step.current ? body(step) : null;
					return (
						<li key={step.id} data-testid={`setup-step-${step.id}`} data-done={step.done ? "true" : "false"} data-current={step.current ? "true" : "false"} className="py-2">
							<div className="flex min-h-8 items-center gap-3">
								<StepMark n={n + 1} done={step.done} current={step.current} />
								<span className={cn("text-body font-semibold", step.done || step.current ? "text-foreground" : "text-muted-foreground")}>{step.title}</span>
								{step.id === "files" && step.done && materialCount > 0 && (
									<span className="ml-auto text-meta tabular-nums text-muted-foreground" data-testid="setup-files-summary">
										{filesSummary(materialCount, reading)}
									</span>
								)}
							</div>
							{content && <div className="mt-2 pl-9">{content}</div>}
						</li>
					);
				})}
			</ol>
		</section>
	);
}
