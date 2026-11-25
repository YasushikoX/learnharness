import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import {
	DeleteSessionBody,
	SESSION_DELETE_COPY,
	courseLossWarning,
	folderDeleteCopy,
	useCourseLoss,
	type CourseLoss,
} from "../components/delete-session-dialog.tsx";
import { DeleteSourceBody } from "../components/delete-source-dialog.tsx";
import type { CourseDeletionImpact, SourceEntry } from "../src/core/index.ts";

// Merge review finding 1: deleting course sessions takes the skill progress they recorded, in either mode (evidence is
// derived from their transcripts). The confirmation names how many course sessions, which courses, and that their
// skills lose that progress; the "everything added to the graph stays" sentence is never shown unqualified then.

const known = (impact: CourseDeletionImpact): CourseLoss => ({ status: "known", impact });
const calc = { id: "c1", title: "Calculus", sessions: 1 };
const UNQUALIFIED_SESSION = "Everything it added to the graph stays unless you check below. ";
const UNQUALIFIED_FOLDER = "Everything they added to the graph stays unless you check below. ";
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"");
const body = (props: { courseLoss?: CourseLoss; copy?: typeof SESSION_DELETE_COPY; traces?: boolean }) =>
	renderToStaticMarkup(<DeleteSessionBody chat={{ id: "x", title: "Limits placement" }} traces={props.traces ?? false} busy={false} failure={null}
		onTraces={() => {}} onClose={() => {}} onRun={() => {}} courseLoss={props.courseLoss} {...(props.copy ? { copy: props.copy } : {})} />);

describe("session Delete with course progress", () => {
	it("a course session: the exact warning, in both modes, and the graph promise qualified", () => {
		const loss = known({ sessions: 1, courses: [calc], skills: 2 });
		for (const traces of [false, true]) {
			const html = body({ courseLoss: loss, traces });
			const t = text(html);
			assert.ok(t.includes("Everything it added to the graph stays unless you check below, except its course progress."));
			assert.ok(!t.includes(UNQUALIFIED_SESSION), "never the unqualified promise");
			assert.match(html, /data-testid="delete-course-loss" role="alert"/);
			assert.ok(t.includes("This is a course session from “Calculus”. Deleting it also deletes the course progress it recorded: the 2 skills it taught or checked lose that progress, whichever you choose below."));
			assert.doesNotMatch(html, /data-testid="delete-confirm"[^>]*disabled=""/);
		}
	});

	it("a session without course progress keeps today's copy and no warning", () => {
		for (const courseLoss of [undefined, known({ sessions: 0, courses: [], skills: 0 })]) {
			const html = body({ courseLoss });
			assert.ok(text(html).includes(SESSION_DELETE_COPY.body));
			assert.doesNotMatch(html, /delete-course-loss/);
		}
	});

	it("while checking Delete waits and the promise is already qualified; a failed check says it could not check", () => {
		const checking = body({ courseLoss: { status: "checking" } });
		assert.match(checking, /data-testid="delete-confirm"[^>]*disabled=""/);
		assert.ok(!text(checking).includes(UNQUALIFIED_SESSION));
		assert.match(text(checking), /Checking whether this session recorded course progress…/);
		const unknown = text(body({ courseLoss: { status: "unknown" } }));
		assert.ok(!unknown.includes(UNQUALIFIED_SESSION));
		assert.ok(unknown.includes("Couldn’t check whether this session recorded course progress. If it came from a course, the skills it taught or checked lose that progress."));
	});
});

describe("folder Delete with course progress", () => {
	const copy = folderDeleteCopy({ sessions: 3, subfolders: 0, notes: 0, parentName: null });

	it("names how many of the sessions are course sessions and which courses", () => {
		const html = body({ copy, courseLoss: known({ sessions: 2, courses: [calc, { id: "c2", title: "Physics", sessions: 1 }], skills: 3 }) });
		const t = text(html);
		assert.ok(t.includes("Everything they added to the graph stays unless you check below, except their course progress."));
		assert.ok(!t.includes(UNQUALIFIED_FOLDER));
		assert.ok(t.includes("2 of these 3 sessions are course sessions, from “Calculus” and “Physics”. Deleting them also deletes the course progress they recorded: the 3 skills they taught or checked lose that progress, whichever you choose below."));
	});

	it("the other counts read naturally; a deleted course is named as such", () => {
		assert.equal(courseLossWarning(known({ sessions: 1, courses: [calc], skills: 1 }), 3),
			"1 of these 3 sessions is a course session, from “Calculus”. Deleting it also deletes the course progress it recorded: the 1 skill it taught or checked loses that progress, whichever you choose below.");
		assert.match(courseLossWarning(known({ sessions: 2, courses: [{ id: "c1", title: "Calculus", sessions: 2 }], skills: 2 }), 2)!, /^Both sessions are course sessions, from “Calculus”\./);
		assert.match(courseLossWarning(known({ sessions: 3, courses: [{ id: "gone", title: null, sessions: 3 }], skills: 4 }), 3)!, /^All 3 sessions are course sessions, from a deleted course\./);
		assert.equal(courseLossWarning(known({ sessions: 0, courses: [], skills: 0 }), 3), null);
		assert.match(courseLossWarning({ status: "unknown" }, 3)!, /If any came from a course, the skills they taught or checked lose that progress\./);
	});
});

describe("Sources view Delete with “Also delete the sessions”", () => {
	const sources = [{ id: "chat_1", kind: "chat", label: "Limits placement" }] as unknown as SourceEntry[];
	const render = (deleteSessions: boolean, courseLoss: CourseLoss) => renderToStaticMarkup(<DeleteSourceBody sources={sources} folders={[]}
		deleteSessions={deleteSessions} onDeleteSessions={() => {}} busy={false} failure="" onClose={() => {}} onRun={() => {}} courseLoss={courseLoss} />);

	it("warns once the sessions are to be deleted; unchecked keeps the sessions and their progress", () => {
		const loss = known({ sessions: 1, courses: [calc], skills: 1 });
		assert.doesNotMatch(render(false, loss), /delete-course-loss/);
		assert.match(text(render(true, loss)), /This is a course session from “Calculus”\. Deleting it also deletes the course progress it recorded/);
		assert.match(render(true, { status: "checking" }), /data-testid="source-delete-confirm" disabled=""/);
		assert.doesNotMatch(render(false, { status: "checking" }), /data-testid="source-delete-confirm" disabled=""/);
	});
});

describe("useCourseLoss", () => {
	it("asks the server for the ids, starts each new set at checking, and falls back to unknown on failure", async () => {
		const dom = parseHTML("<html><body></body></html>");
		const requests: unknown[] = [];
		let reply: () => Promise<Response> = async () => Response.json({ sessions: 1, courses: [calc], skills: 2 });
		Object.assign(globalThis, {
			window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
			fetch: async (url: string, init: RequestInit) => { requests.push([url, JSON.parse(String(init.body))]); return reply(); },
		});
		const seen: (CourseLoss | undefined)[] = [];
		function Probe({ ids }: { ids: string[] | null }) { seen.push(useCourseLoss(ids)); return null; }
		const host = document.createElement("div");
		const root = createRoot(host);
		try {
			await act(async () => root.render(<Probe ids={null} />));
			assert.equal(seen.at(-1), undefined, "closed: nothing asked");
			assert.equal(requests.length, 0);
			await act(async () => root.render(<Probe ids={["a", "b"]} />));
			assert.deepEqual(seen.find((s) => s !== undefined), { status: "checking" });
			assert.deepEqual(requests, [["/api/courses/deletion-impact", { chatIds: ["a", "b"] }]]);
			assert.deepEqual(seen.at(-1), known({ sessions: 1, courses: [calc], skills: 2 }));
			reply = async () => new Response("{}", { status: 500 });
			const before = seen.length;
			await act(async () => root.render(<Probe ids={["c"]} />));
			assert.deepEqual(seen[before], { status: "checking" }, "a new deletion never shows the previous answer");
			assert.deepEqual(seen.at(-1), { status: "unknown" });
		} finally { await act(async () => root.unmount()); }
	});
});
