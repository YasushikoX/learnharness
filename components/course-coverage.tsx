"use client";

import { createContext, useContext, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { lessonLabels, type CourseCoverageView, type CoverageEdit, type CoverageEntryView, type CoverageTermView } from "@/src/core";
import { cn } from "@/lib/utils";
import { SECTION_HEAD } from "@/components/section-heads";

/**
 * The class's vocabulary on the course page (WP5, 2026-11-25; docs/courses.md "Vocabulary coverage"). Minimal and in the
 * page's existing style; this is not the redesign. Four pieces, all reading `CourseView.coverage` through one context the
 * page body provides:
 *   - DraftTerms / DraftCoverageReview: on the approval screen, each draft skill's terms; the core terms the draft leaves
 *     unassigned, each with "Assign to…" and "Exclude"; suggested duplicates side by side with their definitions and a
 *     "Same thing" action; and "Leave N terms unassigned" (approval refuses otherwise).
 *   - SkillTerms: in a skill's detail, "terms: 9 of 11 introduced, 6 checked", which opens the list with each term's
 *     state, definition and page.
 *   - CoverageSummary: class-wide, "N new terms are not assigned to a skill" and "N terms are no longer in the material"
 *     with their actions, and "Map the class's terms" (it only adds assignments for terms with no decision).
 *   - Suggestions: a mapping pass's proposed exclusions and links, each accepted or dismissed one by one (the pass never
 *     applies them itself), and the earlier decisions an approval could not keep.
 * Labels go through core/lesson-labels.ts in the class's language.
 */

export interface CoverageActions {
	edit: (target: "approved" | "draft", edit: CoverageEdit) => void;
	/** "Map the class's terms" on the approved map, or on the pending draft. */
	map: (target?: "approved" | "draft") => void;
	approveLeaving: () => void;
}

interface CoverageContextValue {
	view: CourseCoverageView;
	/** Approved skill id, or draft key, → name. */
	skillNames: ReadonlyMap<string, string>;
	draftNames?: ReadonlyMap<string, string>;
	busy: boolean;
	actions?: CoverageActions;
}

export const CoverageContext = createContext<CoverageContextValue | null>(null);

const BTN = "rounded-md border border-border px-2 py-0.5 text-[11px] transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";
const SELECT = "rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px]";

const where = (e: CoverageEntryView) => [e.material, e.page !== null ? `p. ${e.page}` : null].filter(Boolean).join(", ");

/** One entry: its name, and its definition from the material with the page (or "no definition"). */
function EntryLine({ entry, extra }: { entry: CoverageEntryView; extra?: React.ReactNode }) {
	const ctx = useContext(CoverageContext);
	const L = lessonLabels(ctx?.view.language).coverage;
	return (
		<div className="leading-relaxed" data-testid={`term-${entry.key}`}>
			<span className="font-medium text-foreground">{entry.name}</span>
			{entry.tier === "supporting" && <span className="ml-1 text-muted-foreground/80">({L.supporting})</span>}
			{extra}
			<span className="block text-muted-foreground">
				{entry.definition ?? L.noDefinition}
				{where(entry) ? ` (${where(entry)})` : ""}
			</span>
		</div>
	);
}

/** "Assign to…" (a skill picker) and "Exclude" (with a reason) for one entry. */
function AssignExclude({ target, entryKey, skills }: { target: "approved" | "draft"; entryKey: string; skills: ReadonlyMap<string, string> }) {
	const ctx = useContext(CoverageContext);
	const [excluding, setExcluding] = useState(false);
	const [reason, setReason] = useState("");
	if (!ctx?.actions) return null;
	const L = lessonLabels(ctx.view.language).coverage;
	return (
		<span className="mt-1 flex flex-wrap items-center gap-1.5">
			<select
				className={SELECT}
				aria-label={`${L.assignTo} ${entryKey}`}
				data-testid={`assign-${entryKey}`}
				disabled={ctx.busy}
				value=""
				onChange={(e) => e.target.value && ctx.actions!.edit(target, { action: "assign", key: entryKey, skill: e.target.value })}
			>
				<option value="">{L.assignTo}</option>
				{[...skills].map(([id, name]) => (
					<option key={id} value={id}>
						{name}
					</option>
				))}
			</select>
			{excluding ? (
				<>
					<input className={SELECT} placeholder={L.excludeReason} aria-label={L.excludeReason} value={reason} onChange={(e) => setReason(e.target.value)} data-testid={`exclude-reason-${entryKey}`} />
					<button type="button" className={BTN} disabled={ctx.busy} data-testid={`exclude-ok-${entryKey}`} onClick={() => ctx.actions!.edit(target, { action: "exclude", key: entryKey, reason: reason.trim() })}>
						{L.exclude}
					</button>
				</>
			) : (
				<button type="button" className={BTN} disabled={ctx.busy} data-testid={`exclude-${entryKey}`} onClick={() => setExcluding(true)}>
					{L.exclude}
				</button>
			)}
		</span>
	);
}

/** A mapping pass's proposals awaiting the student: each exclusion and each link accepted or dismissed one by one. */
function Suggestions({ target, suggested }: { target: "approved" | "draft"; suggested: NonNullable<CourseCoverageView["suggested"]> }) {
	const ctx = useContext(CoverageContext);
	if (!ctx || (suggested.excluded.length === 0 && suggested.links.length === 0)) return null;
	const L = lessonLabels(ctx.view.language).coverage;
	return (
		<div className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2" data-testid={`coverage-suggested-${target}`}>
			<div className={SECTION_HEAD}>{L.suggestionsHeading}</div>
			{suggested.excluded.map((x) => (
				<div key={`x-${x.key}`} className="flex flex-wrap items-center gap-1.5" data-testid={`suggested-exclude-${x.key}`}>
					<span className="font-medium text-foreground">{x.name}</span>
					<span className="text-muted-foreground">— {L.suggestExclude(x.reason)}</span>
					{ctx.actions && (
						<>
							<button type="button" className={BTN} disabled={ctx.busy} data-testid={`suggested-exclude-accept-${x.key}`} onClick={() => ctx.actions!.edit(target, { action: "exclude", key: x.key, reason: x.reason })}>
								{L.accept}
							</button>
							<button type="button" className={BTN} disabled={ctx.busy} onClick={() => ctx.actions!.edit(target, { action: "dismiss", key: x.key })}>
								{L.dismiss}
							</button>
						</>
					)}
				</div>
			))}
			{suggested.links.map((g) => (
				<div key={`l-${g.keys.join("~")}`} className="flex flex-wrap items-center gap-1.5" data-testid={`suggested-link-${g.keys.join("~")}`}>
					<span className="text-foreground">{g.names.join(" = ")}</span>
					{ctx.actions && (
						<>
							<button type="button" className={BTN} disabled={ctx.busy} data-testid={`suggested-link-accept-${g.keys.join("~")}`} onClick={() => ctx.actions!.edit(target, { action: "link", keys: g.keys })}>
								{L.sameThing}
							</button>
							<button type="button" className={BTN} disabled={ctx.busy} onClick={() => ctx.actions!.edit(target, { action: "dismiss", keys: g.keys })}>
								{L.dismiss}
							</button>
						</>
					)}
				</div>
			))}
		</div>
	);
}

/** The earlier decisions an approval (or the draft) could not keep, with why. */
function Displaced({ items, target }: { items: NonNullable<CourseCoverageView["displaced"]>; target?: "approved" }) {
	const ctx = useContext(CoverageContext);
	if (!ctx || items.length === 0) return null;
	const L = lessonLabels(ctx.view.language).coverage;
	return (
		<div className="space-y-1 text-muted-foreground" data-testid="coverage-displaced">
			<div className={SECTION_HEAD}>{L.displacedHeading}</div>
			{items.map((d) => (
				<p key={`${d.key}-${d.reason}`} data-testid={`displaced-${d.key}`}>
					<span className="font-medium text-foreground">{d.name}</span> — {d.reason}
				</p>
			))}
			{target && ctx.actions && (
				<button type="button" className={BTN} disabled={ctx.busy} data-testid="coverage-displaced-ok" onClick={() => ctx.actions!.edit(target, { action: "clear-displaced" })}>
					{L.displacedOk}
				</button>
			)}
		</div>
	);
}

/** A draft skill's terms, as small names under it on the approval screen. */
export function DraftTerms({ draftKey }: { draftKey: string }) {
	const ctx = useContext(CoverageContext);
	const terms = ctx?.view.draft?.skills[draftKey] ?? [];
	if (terms.length === 0) return null;
	const L = lessonLabels(ctx!.view.language).coverage;
	return (
		<p className="mt-0.5 text-[11px] text-muted-foreground/80" data-testid={`draft-terms-${draftKey}`}>
			{L.termsHeading}: {terms.map((t) => t.name).join(", ")}
		</p>
	);
}

/** The approval screen's vocabulary block. */
export function DraftCoverageReview() {
	const ctx = useContext(CoverageContext);
	const draft = ctx?.view.draft;
	if (!ctx || !draft) return null;
	const L = lessonLabels(ctx.view.language).coverage;
	const skills = ctx.draftNames ?? new Map<string, string>();
	return (
		<div className="mb-4 space-y-3 text-xs" data-testid="draft-coverage">
			{draft.empty && (
				<p className="text-muted-foreground" data-testid="draft-coverage-empty">
					{L.draftEmpty}{" "}
					{ctx.actions && !ctx.view.mapping && (
						<button type="button" className={BTN} disabled={ctx.busy} data-testid="draft-coverage-map" onClick={() => ctx.actions!.map("draft")}>
							{L.mapTerms}
						</button>
					)}
				</p>
			)}
			{ctx.view.mapping && <p className="text-muted-foreground">{L.mapping}</p>}
			{draft.displaced && <Displaced items={draft.displaced} />}
			{draft.suggested && <Suggestions target="draft" suggested={draft.suggested} />}
			{draft.incomplete.length > 0 && <p className="text-muted-foreground">{L.incompleteLine(draft.incomplete.join(", "))}</p>}
			{draft.dropped.length > 0 && (
				<p className="text-muted-foreground" data-testid="draft-dropped">
					{L.droppedLine(draft.dropped.length)} {draft.dropped.join(", ")}
				</p>
			)}
			{draft.unassigned.length > 0 && (
				<div className="space-y-2 rounded-lg border border-border/60 px-3 py-2" data-testid="draft-unassigned">
					<div className={SECTION_HEAD}>{L.unassignedLine(draft.unassigned.length)}</div>
					{draft.unassigned.map((e) => (
						<EntryLine key={e.key} entry={e} extra={<AssignExclude target="draft" entryKey={e.key} skills={skills} />} />
					))}
					{ctx.actions && (
						<button type="button" className={BTN} disabled={ctx.busy} data-testid="draft-leave-unassigned" onClick={() => ctx.actions!.approveLeaving()}>
							{L.leaveUnassigned(draft.unassigned.length)}
						</button>
					)}
				</div>
			)}
			{draft.duplicates.length > 0 && (
				<div className="space-y-2" data-testid="draft-duplicates">
					<div className={SECTION_HEAD}>{L.duplicatesHeading}</div>
					{draft.duplicates.map((d) => (
						<div key={`${d.a.key}~${d.b.key}`} className="grid gap-2 rounded-lg border border-border/60 px-3 py-2 sm:grid-cols-[1fr_1fr_auto]" data-testid={`duplicate-${d.a.key}~${d.b.key}`}>
							<EntryLine entry={d.a} />
							<EntryLine entry={d.b} />
							<span className="flex items-start gap-1.5">
								{d.linked ? (
									<>
										<span className="text-muted-foreground">{L.linked}</span>
										{ctx.actions && (
											<button type="button" className={BTN} disabled={ctx.busy} onClick={() => ctx.actions!.edit("draft", { action: "unlink", key: d.b.key })}>
												{L.unlink}
											</button>
										)}
									</>
								) : (
									ctx.actions && (
										<button type="button" className={BTN} disabled={ctx.busy} data-testid={`same-${d.a.key}~${d.b.key}`} onClick={() => ctx.actions!.edit("draft", { action: "link", keys: [d.a.key, d.b.key] })}>
											{L.sameThing}
										</button>
									)
								)}
							</span>
						</div>
					))}
				</div>
			)}
			{draft.excluded.length > 0 && (
				<p className="text-muted-foreground" data-testid="draft-excluded">
					{L.excludedHeading}: {draft.excluded.map((x) => `${x.name} (${x.reason})`).join("; ")}
				</p>
			)}
		</div>
	);
}

const stateLabel = (t: CoverageTermView, L: ReturnType<typeof lessonLabels>["coverage"]) =>
	t.state === "checked" ? L.stateChecked : t.state === "asked" ? L.stateAsked : t.state === "introduced" ? L.stateIntroduced : L.stateNew;

/** A skill's terms in its detail: the counts, then the list. */
export function SkillTerms({ skillId }: { skillId: string }) {
	const ctx = useContext(CoverageContext);
	const [open, setOpen] = useState(false);
	const summary = ctx?.view.skills[skillId];
	if (!ctx || !summary) return null;
	const L = lessonLabels(ctx.view.language).coverage;
	return (
		<div data-testid={`skill-terms-${skillId}`}>
			<button type="button" className="flex items-center gap-1 text-muted-foreground hover:text-foreground" aria-expanded={open} data-testid={`skill-terms-toggle-${skillId}`} onClick={() => setOpen((o) => !o)}>
				{open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
				{L.skillLine(summary.introduced, summary.total, summary.checked)}
			</button>
			{open && (
				<ul className="mt-1.5 space-y-1.5 pl-4" data-testid={`skill-terms-list-${skillId}`}>
					{summary.terms.map((t) => (
						<li key={t.key}>
							<EntryLine
								entry={t}
								extra={
									<span className={cn("ml-1.5 rounded-full border px-1.5 text-[10px]", t.state === "checked" ? "border-foreground/40 text-foreground" : "border-border text-muted-foreground")} data-testid={`term-state-${t.key}`}>
										{stateLabel(t, L)}
										{t.level ? ` · ${t.level}` : ""}
										{t.deferredCount ? ` · ${L.deferredCount(t.deferredCount)}` : ""}
									</span>
								}
							/>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** The class-wide coverage line: unassigned and flagged terms with their actions, or "Map the class's terms". */
export function CoverageSummary() {
	const ctx = useContext(CoverageContext);
	const [open, setOpen] = useState(false);
	if (!ctx) return null;
	const { view } = ctx;
	const L = lessonLabels(view.language).coverage;
	if (view.status === "none" && !view.mapping && !view.error) return null;
	const unassigned = view.status === "mapped" ? view.unassigned : [];
	const pending = !!view.suggested || (view.displaced?.length ?? 0) > 0;
	if (view.status === "mapped" && unassigned.length === 0 && view.flagged.length === 0 && !view.mapping && !view.error && view.incomplete.length === 0 && !pending) return null;
	return (
		<section className="space-y-2 text-xs" data-testid="course-coverage">
			{view.mapping && <p className="text-muted-foreground">{L.mapping}</p>}
			{view.error && <p className="text-destructive" data-testid="coverage-error">{view.error}</p>}
			{(view.status === "unmapped" || unassigned.length > 0) && !view.mapping && ctx.actions && (
				<button type="button" className={BTN} disabled={ctx.busy} data-testid="coverage-map" onClick={() => ctx.actions!.map("approved")}>
					{L.mapTerms}
				</button>
			)}
			{view.displaced && <Displaced items={view.displaced} target="approved" />}
			{view.suggested && <Suggestions target="approved" suggested={view.suggested} />}
			{view.incomplete.length > 0 && <p className="text-muted-foreground">{L.incompleteLine(view.incomplete.join(", "))}</p>}
			{(unassigned.length > 0 || view.flagged.length > 0) && (
				<button type="button" className="flex items-center gap-1 text-muted-foreground hover:text-foreground" aria-expanded={open} data-testid="coverage-toggle" onClick={() => setOpen((o) => !o)}>
					{open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
					{[unassigned.length > 0 ? L.unassignedLine(unassigned.length) : null, view.flagged.length > 0 ? L.flaggedLine(view.flagged.length) : null].filter(Boolean).join(" · ")}
				</button>
			)}
			{open && (
				<div className="space-y-2 pl-4" data-testid="coverage-detail">
					{unassigned.map((e) => (
						<EntryLine key={e.key} entry={e} extra={<AssignExclude target="approved" entryKey={e.key} skills={ctx.skillNames} />} />
					))}
					{view.flagged.map((f) => (
						<div key={f.key} data-testid={`flagged-${f.key}`}>
							<span className="font-medium text-foreground line-through decoration-muted-foreground/60">{f.name}</span>
							<span className="ml-1 text-muted-foreground">— {L.flaggedLine(1).replace(/^1 /, "")}</span>
							{ctx.actions && (
								<span className="mt-1 flex flex-wrap items-center gap-1.5">
									<button type="button" className={BTN} disabled={ctx.busy} data-testid={`flagged-remove-${f.key}`} onClick={() => ctx.actions!.edit("approved", { action: "remove", key: f.key })}>
										{L.remove}
									</button>
									{unassigned.length > 0 && (
										<select className={SELECT} aria-label={L.remapTo} disabled={ctx.busy} value="" onChange={(e) => e.target.value && ctx.actions!.edit("approved", { action: "remap", key: f.key, to: e.target.value })}>
											<option value="">{L.remapTo}</option>
											{unassigned.map((u) => (
												<option key={u.key} value={u.key}>
													{u.name}
												</option>
											))}
										</select>
									)}
								</span>
							)}
						</div>
					))}
				</div>
			)}
		</section>
	);
}
