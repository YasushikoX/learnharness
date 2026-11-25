# Courses — curriculum → skill map → known

Status: **as built** (2026-10-24, approved by the owner the same day). Fork addition. Where the build differs from the plan text below, the "As built" section at the end says how.

A course turns a curriculum (PDFs, notes, links) into a map of **skills** that
live in the knowledge graph, tracks how many of them you **know**, and computes
the route from where you are to the whole curriculum from what you know now.

> **2026-11-07:** the Leitner boxes named in the decisions below were replaced by an
> FSRS understanding model (spec: section 2). Read "box" in the older text as
> "understanding"; section 2 is current.

## Owner decisions (2026-10-24)

| Question | Decision |
|---|---|
| Where skills live | A new **skill** node kind in the graph, in its own ledger (`graph/skills.jsonl`). Skills have `requires` edges to skills and `restsOn` links to propositions. A skill two courses need is ONE node shared by both. |
| Curriculum → skills | A **course-planner agent drafts**, the owner reviews ("ask for changes" re-drafts with feedback), and **Approve** writes it to the graph. |
| What "known" means (stand-in) | **Leitner boxes 0–5** per skill, driven by practice outcomes. Clean solve +1, solved with hints = stay, moved on / gave up → box 1. Due after 1/3/7/16/35 days by box. **Known = box ≥ 3.** Overdue still counts as known until a review is missed. |
| Box timing | A clean solve **promotes only when the skill is due** (box 0 is always due). Misses always reset to box 1. |
| The route | **Computed frontier**, no agent: next up = not-known course skills whose prerequisites are all known. |
| What you already know | **Placement check**: a clean placement solve → box 3 *and* every transitive prerequisite → box 3. A placement miss → box 1. |
| Proposition links | **Planner + derived**: the planner stores links to existing propositions; propositions extracted from a Learn session on a skill rest on it, derived at read time (not stored). |
| Which practice moves boxes | **Course sessions only** (Practice, Review, Placement started from a course). |
| UI | A **Courses section in the sidebar** (above sessions) plus a **course page** `/course/[id]`. Sessions started from a course are labelled with it. |
| Canvas | **Course page only for v1.** The home canvas is unchanged. |

## Owner decisions (2026-10-25 — after the first real lesson)

The first ITGK lesson showed four gaps: no way to finish a lesson (so nothing
unlocked), a placement check nobody found, wrong answer keys, and no teaching
between questions. Decided:

| Question | Decision |
|---|---|
| Who finishes a Learn session | **Both**: the teacher's `finish_lesson` tool (goal demonstrated, or the learner asks) and a **Finish lesson** button on the session's top bar. Either logs it; the first one counts. The session stays open afterwards. |
| What finishing does | The skill becomes **learned** (box ≥ 1). |
| The unlock rule | **Learned unlocks**: a skill is next up once every prerequisite is learned (box ≥ 1). Known (box ≥ 3) stays the progress number, earned by spaced practice and review. |
| Learned, not known | A new **Learning** group (box 1–2) on the course page, with Practice and Learn again. **Practice all** practices this group. |
| The curriculum test | A **quick multiple-choice placement test** (a soft target of about a third of the skill count; the hardest technical skills first, judgment skills last, credited skills never re-asked), offered first after approval ("Find your starting point", with "Start from the beginning"). It replaces the problem-based placement check. |
| Placement grading | **Confidence-weighted**: correct with confidence ≥ 70 → known (box 3) plus every transitive prerequisite; correct but less sure → learned (box 1); wrong or "I don't know" → nothing (never lowers, never counts as learned). **A direct miss beats inferred credit:** a skill missed directly is never credited as someone else's prerequisite, whichever answer came first (owner, 2026-10-25). |
| A miss in practice | Back to box 1 — but a skill at box 0 stays there: a miss never counts as learned (follows from "learned unlocks"). |
| Wrong answer keys | **Solve first**: the quiz schema emits the worked `explanation` before the `options`; the options are built around the answer it reaches. **Then checked before posing** (all three multiple-choice tools): the question's one python block is run (its printed output, when it is an option, must be the key); an optional `verify` program must print the correct label; anything Python did not settle is solved blind by the `checker` role, which never sees the key (`core/answer-check.ts`, `server/question-check.ts`). A checker disagreement refuses once; the same call sent again unchanged goes through. |
| Skills had from another course | **A context check, never a course**: a course skill learned or known on evidence from other courses only is listed under **From another course** with **Quick check** — a short practice session (`mode: "check"`: one problem, two at most, framed in this course's terms; only what differs here is explained). Optional: the skill stays learned/known and unlocks what builds on it. The placement test skips these skills. |
| Finishing any course session | **Every mode finishes**, not only Learn: the agent's `finish_session` (practice, review, context check, placement — when the course section says the work is done, or the learner asks) or the learner's **Finish session** button (top bar; refused over an open question or a live problem). It only marks the session done; a Learn finish still makes the skill learned. Finished sessions show **Finished** with a check in the sidebar, and fold into a collapsed **Finished** group under the course page's Sessions. |
| The skill map's size | The map lives in a **pan/zoom viewport** that opens readable (zoom 0.9, centered on what is due or next up) instead of the whole map shrunk into the column (a 32-skill map's text had shrunk to ~5px). Drag pans, Ctrl/⌘ + wheel zooms (a plain wheel scrolls the page), buttons zoom, fit and **expand** the map to the window. A map that is readable whole shows whole. |
| The skills you know | **In the knowledge graph**, as its second node kind: every held skill (learned or known) drawn as a rounded square in the skill color — solid when known, faint while learning, ringed when due — with arrows from its prerequisite skills and from the propositions it rests on, and one region per course. Clicking one opens its card (state, courses, what it rests on). The snapshot carries them as `skills` (`graphSkillLayer`); the canvas folds them in at fetch (`withSkillLayer`). |
| Short lessons in the graph | **Extract on finish**: a finished Learn session extracts whatever text is left, however little (`extractionDue`); a lesson under the batch budget used to never reach the graph. |
| No teaching between questions | **Gate + prompt**: the teacher's quiz/explain call, and its `ask_user_question` (since 2026-11-05, answered through `send_to_user` or plain text), is refused when no text has reached the learner since their last graded answer (`core/prose-gate.ts`), plus a teaching-prompt rule. |

## 1. Data

### 1.1 Skills ledger — `data/graph/skills.jsonl` (new, append-only)

```ts
interface SkillLine {
  id: string;          // "sk_" + nanoid-like, store-assigned
  name: string;        // short handle, like a node's name ("Chain rule")
  statement: string;   // the checkable ability: "Differentiate a composition f(g(x)) with the chain rule"
  requires: string[];  // skill ids that must be known first
  restsOn: string[];   // proposition ids (n_…) — the planner's stored links
  createdAt: string;
}
```

Same discipline as `nodes.jsonl`. The **first line for an id defines**
name/statement/createdAt. Later lines for the same id are **link-appends**:
their `requires` and `restsOn` union in (a second course reusing a skill can add
edges). A line with `reworded: true` also replaces name/statement, the last one
winning — the planner re-words a reused skill in the course language when it is in another. Readers merge by id. References to dead propositions (graph deletion)
or unknown skills are dropped at read time, never rewritten.

- `GraphStore` port gains `readSkills(): Skill[]` and `appendSkills(lines)`.
  `src/store/graph.ts` implements both. `LEDGER_FILES.skills` is added to
  `config.ts`. No graph format bump: an existing file doesn't change shape, and
  older builds ignore the new file.
- **Writer:** the course-approval seam (`approveCourse`) is the skills ledger's
  ONLY writer. The extraction pipeline stays the sole writer of
  nodes/chains/coverage. `architecture.md` records this as the ledger's owner.

### 1.2 Course store — `data/courses/<courseId>.json` (new; `CourseStore` port, sole writer `src/store/courses.ts`)

```ts
interface CourseRecord {
  id: string;                 // "course_" + random
  title: string;
  createdAt: string; updatedAt: string;
  version?: number;           // schema stamp, same lazy-v1 rule as chats
  status: "new" | "drafting" | "draft" | "active" | "error";
  skills: string[];           // the APPROVED skill set (sk_ ids); [] until first approval
  draft?: CourseDraft;        // the pending planner output (cleared on approve)
  language?: "en" | "nb";     // the course's language (stamped from the default at creation; absent = the current default)
  error?: string;             // last drafting failure
  drafts?: CourseDraftUsage[];// planner usage log (money channel, like extractions)
}
interface CourseDraft {
  createdAt: string;
  summary: string;            // the planner's short prose: approach, what it reused
  feedback?: string;          // the owner's change request this draft answered
  skills: DraftSkill[];
}
interface DraftSkill {
  key: string;                // draft-local "s1", "s2", …
  reuse?: string;             // an EXISTING sk_ id this IS (identity judgment, like the auditor's link)
  name: string; statement: string;
  requires: string[];         // other draft keys
  restsOn: string[];          // existing proposition ids
  cite?: string;              // where in the curriculum ("Ch. 3, p. 41")
}
```

- **Approve** turns the draft into ledger lines. A new skill gets a fresh
  `sk_` id. A `reuse` skill is link-appended with any new edges. The course's
  `skills` becomes the draft's resolved id set, and status becomes `active`.
  Approval **validates**: requires form a DAG and stay inside the course's
  skill set, restsOn ids exist, and reuse ids exist.
- **Re-planning after approval:** add more material or ask for changes →
  Draft again → Approve again. Approval replaces the course's `skills`. Skills
  dropped from a course stay in the graph (shared, and their history keeps).
- **Materials:** the existing `materialStore`, keyed by the course id
  (`data/materials/course_…/`). Profiling is unchanged (`src/server/materials.ts`
  seams take an owner id instead of assuming a chat).
- **Delete course:** removes the record and its materials. Skills stay in the
  graph. Sessions stay, and their course label falls back to plain sessions.

### 1.3 Chat record — `course?` link (contracts/chat.ts)

```ts
course?: { courseId: string; mode: "learn" | "practice" | "review" | "placement" | "ask"; skillIds: string[]; retest?: true; vocabulary?: string[] };
```

Stamped at creation by the course-session route and never changed afterwards. `vocabulary` (WP5) holds the
vocabulary item keys a Learn or one-skill Practice session was listed when it started ("Vocabulary coverage").
`learn` = a teach session aimed at one skill. The other three are practice
sessions.

### 1.4 Practice `problem` tool — optional `skills`

Present **only when the session has a course**: `skills?: string[]`, the skill
id(s) the problem tests. They are checked against the session's skill set
(rejected otherwise) and normalised from names to ids, like `target`. They are
stored in the tool call's arguments, so the record carries the evidence and
nothing is stored anywhere else.

## 2. Understanding — `src/core/mastery.ts` (pure, browser-safe, derived on read)

Every skill has an **FSRS-6 memory state** (difficulty, stability) folded from the
course sessions' evidence in time order, using the pure model of the `ts-fsrs`
package with its default parameters, no learning steps and no fuzz. Stability *S*
is the number of days for recall to fall from 100% to 90%; retrievability *R(t, S)*
is the chance of recall `t` days after the last review. Background:
<https://github.com/open-spaced-repetition/awesome-fsrs/wiki/ABC-of-FSRS>.

**Events** (`skillEventsOf`, per course chat):
- practice / review → every concluded problem with `skills` → `{ skillId, at: conclude timestamp, outcome, grade? }`; `grade` is the grader's per-skill grade from the `conclude` RESULT's `details.grades` (`concludeGradesOf`; records from before the grader keep the tutor's own `grades` argument);
- Learn → its finish (`sessionFinishOf`: a clean `finish_lesson` call, or a `lesson-finished` marker from before 2026-11-13, the first one) → `finished`, with the grader's grade of the final problem when the finish result carries one (see "The final problem" below);
- placement test → every answered placement `probe` (its `skill` arg + the answer's `correct`/`confidence`/`dontKnow`) → `placementKnown` / `placementUnsure` / `placementMiss`;
- legacy placement checks (problems, before 2026-10-25) keep `placement: true`.

**Grades** are the Anki scale, least to most learned: `again`, `hard`, `good`, `easy`.
A separate **grader** model grades each tagged skill of a problem (owner, 2026-11-09: the tutor
graded a hint-assisted, 30%-confident review `good`). When a `conclude` succeeds in a course
session, the practice agent's `afterToolCall` hook (`src/agent/practice-grade.ts`) slices the
problem out of the live turn (pose to conclusion: statement, committed solution, the learner's
work with stated confidence, tutor replies, sketch read-backs, the tutor's own conclusion;
`src/core/practice-grading.ts`), runs the `grader` role (strong slot, Settings override;
`src/agent/subagents/grader.ts`, whose owner-approved rubric is code, not an editable fragment)
and writes the grades into the result's `details`. The tutor no longer grades: `conclude` has no
`grades` field and drops one sent anyway. A skill the grader skipped gets the cautious default
(a solve counts as `hard`, other outcomes keep their own default).
A record without grader grades (older chats) takes the tutor's own, then the outcome's default.

**When the grader fails (owner, 2026-11-13).** A grader slot out of credit once left nine
problems ungraded with nothing on screen. Now (`src/server/practice-grade.ts`):

- **Fallback.** If the grader's model is missing, errors or passes its 120 s limit, the
  session's own model grades once with a 60 s limit (`gradeWithFallback`). No second attempt
  when the session already runs on the grader's model, and none when the learner stopped the turn.
- **What is stored**, beside `grades` in the conclude result's `details`: `gradedBy: "session"`
  only when the fallback graded, and `gradeError`, a short readable reason for the grader's
  failure ("out of credit (Google)", `core/grade-failure.ts`), kept when the fallback graded and
  when nothing did. With nothing graded `grades` is `[]` and the cautious default applies.
- **The concluded card** shows nothing new when the grader worked; "Graded by the session's
  model. The grader failed: …" after a fallback; and "Not graded. The grader failed: …. A
  cautious default grade applies." with a **Grade again** button when nothing graded (an older
  ungraded problem shows the same line without a reason).
- **Grade again** (`POST /api/chats/[id]/regrade { toolCallId }`, `regradeConcludedProblem`)
  grades the stored problem with the same fallback and writes the grades into that conclude
  result. It is refused (409) while a turn or a compaction runs in the chat, since their saves
  replace the whole message list; a grading that fails again leaves the record unchanged and
  the reason shows under the button. On success it emits `record-changed` and
  `courses-changed`. This is the only place an earlier message is edited; docs/sync.md has the
  merge rule that goes with it.

Each event is one FSRS review:

| Event | Grade |
|---|---|
| tutor's `grade` | as given |
| `finished` | the final problem's grade; hard when a grading ran and left none; good for a finish from before the final problem |
| `solved` (no grade) | good |
| `solvedWithHints` (no grade) | hard |
| `movedOn` / `surrendered` / `taught` (no grade) | again — on a skill never learned: ignored, a miss never counts as learned |
| `dismissed` | ignored |
| `placementKnown` (correct, confidence ≥ 70) | the skill easy, then seeded to ≥ 40 days of stability (`PLACEMENT_SEED_DAYS`, understanding ≈ 6.3: known at once); every transitive `requires` good, seeded to ≥ 7 days (`PREREQUISITE_SEED_DAYS`, ≈ 3.5: learning; 20 days until 2026-11-16, shortened so an inferred prerequisite is confirmed by practice within a week), except a skill with a `placementMiss` of its own |
| `placementUnsure` (correct, < 70) | hard |
| `placementMiss` (wrong / I don't know) | nothing; blocks its inferred credit (any order) |
| legacy placement: solved / with hints / miss | as `placementKnown` / hard / nothing |

A review at the same moment as the last adds no stability (no credit for drilling);
a review once recall has faded grows it more. `taught` is the outcome for a problem
where the tutor showed the correction and taught the point itself.

**The final problem (owner, 2026-11-13).** Finishing a lesson used to count as `good` whatever
happened in it, and the first practice afterwards mostly needed hints. A course Learn session now
ends with ONE unaided problem (`core/final-problem.ts`):

- **Form.** The teacher poses it with `explain` and `type: "final"`: always free-form (writing or
  a sketch, no options), whatever the Quizzing setting. A multiple-choice lesson keeps `quiz` for
  its checks and gets `explain` for the final problem alone (`ExplainScope` in `agent/tools.ts`).
  The dock labels it "Final problem", shows "No hints. Sets your first rating." and has an
  "I don't know" button. It arrives open, never behind the reveal.
- **The finish gate.** `finish_lesson` is refused until a final problem has been answered since
  the last finish attempt, and when the answer was "I don't know" (`finishGateProblem`, chained
  with the teacher's other gates and under the same refusal budget).
- **The grade.** When `finish_lesson` goes through, the teacher's `afterToolCall` hook
  (`agent/lesson-grade.ts`) has the practice grader, with its fallback, rate the final problem
  for the lesson's skill from the final problem to the finish call. The grade rides the finish
  result's `details.grades`, like a conclude's, and is the skill's first rating. `again` turns
  the finish into an error result ("NOT FINISHED"): the transcript holds no clean finish, the
  skill stays not learned, and the teacher repairs the gap and poses a new final problem. A
  grading that fails altogether lets the finish stand; the fold counts it as `hard`.
  Hint-button hints taken on the lesson's earlier checks (not steered answers, not the tutor's own
  repairs) ride after the final problem's lines as a labelled block (`lessonHintsBlock` in
  `core/final-problem.ts`, owner 2026-11-19); the grader sizes them and the usual cap applies
  (nudge: Good at most, carry: Hard at most), never down to `again`.
  The page each hint was written from (kept under `sketches/<chat>/hint-pages/`, on the device that
  gave the hint only) rides the hinted answer to the tutor as images under sketch-shaped labels
  (`hintPageId` in `core/sketch.ts`, `toLlmMessages`'s `hintPages` resolver) until the tutor has
  recorded them with `read_sketch`; a hint-page read never ends the turn and has no card, and its
  reading is added to that hint's line in the grader's block. Practice hints work the same way
  (owner, 2026-11-19): a `practice-hint` marker's page rides the marker's message, and the reading
  is added to its `HINT BY BUTTON` line (`renderProblemSpan`).
- **The Finish lesson button** no longer finishes a Learn session. It appends a `lesson-finished`
  marker with `details.request: true` ("Finish requested · final problem next") whose text tells
  the teacher to pose the final problem at once. `sessionFinishOf` skips request markers; a Learn
  marker from before this change has no `request` and still counts as the finish it was. Every
  other course session's Finish button is unchanged.

**Understanding (0–10, what the learner sees)** = `ln(1 + S) / ln(1 + 365) × 10`: how long
the skill lasts, a year being 10 (S = 1 day: 1.2, 8: 3.7, 30: 5.8, 100: 7.8). It does not
fall as days pass. **Needs review** = retrievability now below 90% (`DESIRED_RETENTION`),
i.e. one stability after the last review. **Learned** = has a memory state (a review
happened); it unlocks what builds on it. **Known** = understanding ≥ 6
(`KNOWN_UNDERSTANDING`, about a month of memory). The skill count "x/y known" counts
the known skills. **Course progress %** (owner, 2026-11-08) is the average of each skill's
`knownShare` = understanding / 6, capped at 1 (`courseProgressPercent`), so a known skill is
100%, an inferred prerequisite (5.2) is 87%, and the 0–10 depth above the line adds nothing to
coverage. The skill rows keep the 0–10 score with a "lasts about …" note (`lastsLabel`: the
stability behind the number).

**Views (pure functions of skills + states + now):** `review` = learned and needs
review, in topological order (the review queue's ordering, cap and mix are a later
step). `nextUp` = not learned with every `requires` learned, in topological order.
`learning` = learned, not known. `locked` = not learned with some prerequisite not
learned, listing which. `known`. `contextCheck` = learned, but this course has no
evidence on it (`inCourseEvidence`: a fold of the course's own events — inferred
placement credit included — plus any skill its sessions touched); it also stays in
`known`/`learning`.

Nothing is stored. The course API computes the fold from chat records on read,
in line with the graph's "derive, don't store" rule.

**Review sessions (2026-11-07).** A Review session is not every due skill: `pickReviewSkills`
(core/mastery.ts) takes at most `REVIEW_SESSION_SIZE` = 6 of the skills that need review: the
four with the lowest understanding, the one not practiced for the longest of the rest, and one
morale skill (the highest understanding of what is left). With six or fewer, all of them. They
are posed morale first, then weakest to strongest, and the unpicked ones stay due for the next
session (`CourseView.reviewBatch` is how many the next one takes). The prompt
(`coursePromptSection`) says the listed skills ARE the session, and that every skill is tested
in the listed order; a problem may group several skills at a higher difficulty.

**Retest what I know (owner, 2026-11-16).** A row in the Next up box (shown once any skill is learned
and `plan.retestCount` > 0) starts a placement test on only what is not learned or needs review, so a
learner who comes back after months, or just before the exam, does not re-answer what they still hold.
The credit rules are the placement test's (confidence 70 or more renews the skill and its prerequisites)
with one change: a wrong answer or "I don't know" on a skill learned before is a `retestMiss`, folded as
an `again` (a lapse: the memory shortens and the skill returns to review); on a skill never learned the
fold ignores the `again`, so a miss still changes nothing. A skill missed in a retest also blocks
inferred prerequisite credit, like a direct placement miss.

**Missed problems (owner, 2026-11-16).** A course practice, review or check problem concluded as
`surrendered`, `movedOn`, `taught` or `solvedWithHints` is a miss (a dismissed one is not). Misses are
derived from the chats (`core/missed-problems.ts`, nothing stored): a miss is open until a LATER problem
that covers every one of its skills is concluded `solved`. A practice or review session tells the tutor
about the open misses that share a skill with it (the "MISSED EARLIER" block of `coursePromptSection`,
newest first, at most 6) and asks for a VARIANT of each: same idea and difficulty, a fresh surface, never the
original, counted as one of the session's problems. The course page lists the open misses (`CourseView.missed`,
at most 20) under Due for review, each with **Retry as new variant**, which starts a practice session on
that problem's skills.

**Exam-aware review (owner, 2026-11-16).** With an upcoming exam date, a learned skill also needs
review when it is fine today but its projected recall on exam day is below 90%
(`fadesBefore`, `partitionSkills(…, examAt)`; `SkillPartition.fading` lists those, and the Next up
box and the Due for review heading say "N fading before the exam"). The skill's own view still
says recall is fine today. In the session pick, the four "weakest" slots take the highest
`examReviewScore` = exam weight (`readinessWeight`: priority shrunk by the past-exam count, so a
priority-0 skill sinks without vanishing) × (1 − projected recall on exam day); the stalest and
morale slots are unchanged. A course with no exam date, or one whose exam has passed, behaves as
above.

**Difficulty (2026-11-07, core/difficulty.ts).** Every practice-kind session carries
`ChatSettings.difficulty` (default Short; the general default `GeneralSettings.difficulty`
(Settings → General → Practice) stamps new sessions; the pill in the composer edge changes it): Short 1 skill ~3 min, Medium 2
skills ~6, Long 3-4 ~12, Exam 4-6 ~20 and exam-level (calibrated to past exams in the course
sources when there are any). The level's skill cap is enforced by the `problem` tool; minutes
and "size by the work, not only the skill count" are prompt-only (`<difficulty>` section,
practice agent only). Practice prompt fragment added: `30-short-sessions.md` (short feedback, the tutor decides when to show the
correction and teach it, ending as `taught`, at most one retest after a taught problem).
A concluded problem that ended taught / moved on / surrendered shows a "Learn <skill>" button
per again-graded skill: it opens a Learn session on that skill, and Next problem continues
the review on return.

**Rating change after a problem (owner, 2026-11-13).** A concluded course practice, review or check
problem shows under its card how it moved its skills: "Product rule: understanding 3.1 → 4.2 · review in 5
days". `GET /api/chats/[id]/rating-changes` (`ratingChanges` in `src/server/courses.ts`) folds every
course's evidence before each problem of the session and with it (the same `foldSkills` the course page
reads), one request per chat for all its cards; `components/rating-change.tsx` asks again when a turn
settles, since the problem is only in the record by then. Nothing is stored.

**The lesson's result (owner, 2026-11-13).** What the teacher says it showed when it finishes a lesson (the
`summary` argument of the clean `finish_lesson` call, `finishSummaryOf` in `core/course-session.ts`) used to
be read by nothing. It is now the skill's **lesson note**, derived from the transcript on read (nothing is
stored): the skill's detail on the course page shows it with a link to the lesson
(`CourseSkillView.lessonNote`, the newest finished lesson wins), and the context marker of a later Practice,
Review or Check session lists it under the skill ("note from its last lesson: …") as the tutor's opening
reminder. Under the finish divider a **result card** (`GET /api/chats/[id]/lesson-result`,
`components/lesson-result-card.tsx`) shows the skill, its new understanding and when it comes up for review,
the summary, and three buttons: Practice this skill (starts a practice session on it), Next: <skill> (the next
in the exam-ordered Next up; opens the course page on its pace dialog) and Back to the course.

**Sources before the plan (owner, 2026-11-13, `core/sources-gate.ts`).** In 22 tablet chats the tutor
searched the course's sources once, and only after the learner asked for the full syllabus. In a course
Learn session whose tutor has `material_search`, `plan_init` is now refused until a lookup
(`material_search` or `material_read`) has succeeded, and the FIRST plan must carry a `sources` field
saying what the lookup showed and what the plan uses (a later rewrite of the map does not need it again).
Under the same refusal budget as the other teacher gates (since 2026-11-25: 2 per gate and 3 in all per learner turn, `agent/refusal-budget.ts`), and the planning prompt says the same.

**The recall opener and a mixed Practice all (owner, 2026-11-13).** A Learn session whose skill has learned
prerequisites opens its teaching (after the plan, before the first step) with one or two short free-form
questions on them: `explain` with `type: "recall"` and `skill` (a learned prerequisite of the lesson's skill,
validated; none learned = no opener, and the tool refuses the type). No hints, they arrive open, and the dock
labels them "Recall". The grader rates each when the lesson finishes (`recallOpenersOf` in
`core/final-problem.ts`, graded in `agent/lesson-grade.ts` only on a finish that goes through) and the grades ride
the finish result as `details.openers`; the fold reads each as a `solved` review of its skill at the finish time
(`skillEventsOf`), so a good answer strengthens that skill's memory and a miss brings its review forward. A
grading that fails adds nothing. "Practice all" poses the learning skills in a shuffled order (`shuffled`), so
the session interleaves them; the context marker says "in a mixed order".

**Course folders (owner, 2026-11-14, `core/course-folders.ts`).** The sidebar can separate courses by year or
semester. A folder is a NAME on each course (`CourseRecord.folder`, 1 to 60 characters, one level), not a
registry: it exists while a course is in it, you make one by moving a course into "New folder…", and an emptied
folder is gone. Because it is a course field it syncs per field like the title (`docs/sync.md`), so an older
build cannot wipe it. Names match case-insensitively and a new name takes the spelling an existing folder has.
The order depends on the names alone, never on activity: courses with no folder first, by name; then folders,
HIGHEST name first (name them "2026-2 Høst", "2026-1 Vår" so the newest is on top; numbers compare as numbers);
courses by name inside a folder. `PATCH /api/courses/[id]` takes `folder` (null or blank takes the course out);
`POST /api/courses/folders` renames a folder (every course in it moves, merging into a folder of the new name)
or removes it (its courses leave it; none is deleted).

**Retry on another model (owner, 2026-11-13, `core/turn-fallback.ts`).** When a turn fails with a recognised
provider failure, the banner offers "Retry on <Cheap slot model>" beside Retry: one press moves THIS session
to that model (its other settings kept) and retries. It is never automatic, and only between API-key models:
a subscription session (Claude Code, ChatGPT, Copilot, ...) gets no button and a subscription is never the
target, so the rule that subscriptions do not fall back stays. The target must have a key and differ from the
model that failed.

**Exam date, weights and Today (owner, 2026-11-13, `core/exam-plan.ts`).** A course may carry an
exam date and a weight per skill, so the learner spends the time left on what the exams use:

- **Stored** on the course record: `examDate` ("YYYY-MM-DD"), `skillWeights` (skill id → `{w: 0-3,
  reason?, by: "model" | "learner"}`), and the weighing pass's `weightsSummary`, `weightsAt`,
  `weightsError`. A skill without a weight counts as 1, so a course with no weights behaves exactly as
  before. Weights belong to the course, not the skill (a skill two courses share is weighed in each).
- **Weigh by exams** (`agent/subagents/exam-weigher.ts`, role `coursePlanner`, started by
  `POST /api/courses/[id]/weigh`, runs in the background like drafting): one pass over the sources (past
  exams first, then exam-preparation sets, then the syllabus; it reads them with the lookup tools) and
  the approved skill list; every skill gets 0 (never examined), 1 (sometimes, or unknown), 2 (several
  exams) or 3 (nearly every exam) with a one-line reason, and the summary says when no past exams were
  found. The submit check refuses a missing, repeated or unknown skill. A re-weigh keeps every weight the
  learner set by hand (`mergeModelWeights`). The skill map itself is never touched.
- **Priority.** A skill's priority is the highest weight among itself and everything it unlocks, so
  the prerequisites of heavily examined skills come first. **Next up** is ordered by priority (ties keep
  the topological order). A next-up skill with priority 0 (not examined, and nothing examined builds on
  it) moves to a collapsed **Not examined** group; it can still be learned.
- **Countdown and forecast.** With an exam date the page shows the days left, the skills left (Next up
  and Locked, not examined ones left out), the lessons a day they need, and the recent pace: Learn
  finishes over the last 14 days (fewer, at least 3, while the course is young). "On track" when the pace
  covers the need, "behind" when not. The exam day itself is not a study day.
- **Exam readiness (owner, 2026-11-14, `examReadiness` in `core/exam-plan.ts`).** One percent for how ready the learner is
  for the exam, shown on the exam card of a course that has been weighed (a weighing pass ran: a hand edit does not
  count; before that the card says "Weigh by exams to get a readiness score"). Each skill's credit (understanding over
  6, capped at 1, as in the course percent) is weighted by how likely the skill is to matter on the next exam:
  `(frequency × exams + 1) / (exams + 2)`, where the frequency is assumed from the skill's **priority** (3 every exam,
  2 half of them, 1 a fifth, 0 none: `READINESS_FREQUENCY`) and *exams* is the number of past exams the weighing found
  (`pastExams`, stored with the weights and synced in the same unit; a weighing from before it was recorded assumes 3
  and says "assuming 3 past exams" until Weigh again). Priority already counts what a skill unlocks, so a prerequisite
  no exam asks about directly (the product rule) weighs like the skills built on it. Fewer exams leave the rarely tested
  skills more of the score (two exams: about 41% in Matte 1; five: about 8% in Kyb Intro), a higher priority always
  weighs more, and 100% needs every skill, never-tested ones included. The **tick** on the bar is the score if every
  priority 2-3 skill were known and nothing else (ADE 75%, Kyb Intro 92%, Matte 1 59%); the 80/20 idea is an outcome of
  the weights, not a fixed split, because the foundation and the most tested skills are 52-84% of a course's skills.
- **Today.** Reviews due, then enough lessons to hold the pace (1 to 3; 1 without an exam date), taken
  from the ordered Next up. It shows on the course page (Start / Learn buttons) and as a list above
  Courses in the sidebar (`GET /api/today`, courses with the soonest exam first, five lines at most): a
  review line starts the review, a lesson line opens the course page on that lesson's pace dialog
  (`?learn=<skill id>`).
- **What the teacher is told (owner, 2026-11-14).** The course's sessions get one line from the exam date in the
  `<pace>` section, "The learner's exam: 14 Dec 2026, 30 days left. Use it to judge how much to cover and what to
  cut" (plus "but keep the usual depth unless he asks to move faster" for Thorough); "tomorrow" or "today" near the
  day; nothing without a date or after the exam; read fresh every turn (`examWhen`, `paceSection`). The old free-text time note is no longer
  edited or read; its stored field and sync stay.
- **By hand.** `PATCH /api/courses/[id]` takes `examDate` (null clears) and `weights` ({skill id: 0-3 |
  null}); a skill's detail panel has 0-3 buttons and Reset. The sync merges `examDate` per field and the
  weights, their summary, time and failure as one unit (`COURSE_WEIGHTS_UNIT`).

**Derived proposition links:** a skill's propositions = stored `restsOn` ∪ every
proposition whose provenance includes a chat with `course.mode === "learn"` and
that skill in `skillIds`.

## 3. The course-planner agent — `src/agent/subagents/course-planner.ts`

- New model role **`coursePlanner`**. It gets a row in Settings → per-role
  models, and the default chain falls back to the strong slot like the others.
- Built on `runSubmitAgent`, with extra read tools: the material lookup tools
  (keyed to the course), and graph exploration over propositions and **skills**
  (the auditor's `find`/`list_propositions`, plus a new `list_skills`).
- Input: course title, every material profile, the existing skills
  (id/name/statement), and on a re-draft the previous draft plus the owner's
  feedback.
- Doctrine (new prompt fragment `prompts/course-planner/`): every skill is
  **specific and checkable**, i.e. a practice problem can test it. One skill is
  one ability, and every target the curriculum states is covered. `requires`
  only where truly needed. **Reuse** an existing skill when it is the same
  ability; prefer a duplicate over a wrong merge (the auditor's rule). Link
  `restsOn` only to existing propositions that are genuinely the facts the skill
  uses. Cite the curriculum.
- Submit validation (an error result lets the agent retry): unique keys, valid
  references, acyclic, and every curriculum material referenced at least once.
- Runs in the background like material profiling: waits for profiles, sets
  status `drafting` → `draft` / `error`, logs usage into `drafts`, and emits
  `courses-changed`.

## 4. Sessions from a course

`POST /api/courses/[id]/sessions { mode, skillId?, skillIds?, pace? }` creates the chat with the
`course` link and a **course-context marker** as message[0] (same mechanism as
the graph-context marker). The marker lists the session's skills (statement,
box, due) and their propositions with the chains among them. A generated first
learner message starts the turn, and the client navigates to `/chat/<id>`.

**Practice on a chosen set (owner, 2026-11-14).** Practice takes one `skillId`, a `skillIds` list, or neither (then every
skill being learned, mixed). A list may hold any learned skill (known ones too: practice keeps them sharp, and a miss
lowers them as in any practice) or next-up skill; it is deduped, mixed, and refused when empty (400), when a skill is
not in the course (400), when a skill is locked (409: learn what it builds on first), or in any mode but practice (400).
A long set titles the session with three names and "+n more".

| Mode | Kind | Skills in context | First message |
|---|---|---|---|
| Learn (one skill) | teach | the skill; its prerequisites as known background | "I want to learn to: <statement>" |
| Practice (one skill, or all of Learning) | practice | the chosen skill(s) | "Practice: <names>" |
| Review | practice | the due skills | "Review my due skills" |
| Placement test | conversation — the placement tester (`createPlacementAgent`) | all course skills except those had from another course | "Placement test for <course>" |
| Retest (a placement test with `retest: true` on the session link, 2026-11-16) | the same placement tester, with a retest paragraph in its course section | skills not learned yet, and learned skills that need review (due now or fading before the exam): `retestSkills` | "Retest for <course>: only what I have not learned or need to review" |
| Context check (one skill had from another course) | practice | the skill | "I already know this from another course — check that I can use it in <course>: <statement>" |

- **Course materials serve every course session.** `materialsForTurn` adds the
  course's materials (profiles plus lookup tools) beside the lesson's own.
- **A per-turn course section** (like the materials section) is added to the
  practice agent's system prompt. It explains skill tagging, and for
  placement: one problem per skill, start from the most advanced skills, and
  skip a skill once a dependent has been cleanly solved (prerequisites are
  credited), with only that problem's skills tagged.
- Titles: "Learn: <skill>", "Practice: …", "Review: <course>", "Placement: <course>".
- **Finishing a Learn session** (2026-10-25, changed 2026-11-13): the teacher's
  `finish_lesson` (`agent/tools/course.ts`, teacher phase of course Learn
  sessions only) after an answered final problem; it renders the "Lesson
  finished · <skill> learned" divider and the top bar's button turns into
  "Finished". The learner's `{ type: "finish" }` input event (400 outside a
  course session, when already finished, or over an open question) is, in a
  Learn session, a request for the final problem (section 2).
- **The placement tester** (2026-10-25): its own prompt directory
  (`prompts/placement/`, plus the shared voice, accuracy, question craft,
  confidence and formatting fragments — no teaching base) and a registry of
  `probe` (the multiple-choice quiz with a leading, validated `skill`) +
  `ask_user_question`. It keeps the `probe` name so the question dock
  renders it unchanged. No graph extraction runs on placement sessions.

## 5. API (thin route handlers → `src/server/courses.ts`)

- `GET/POST /api/courses`: list (with % known) / create (`{ title }`).
- `GET/PATCH/DELETE /api/courses/[id]`: record + progress view (boxes, due, next up / locked / known, per-skill propositions) / rename / delete.
- `POST /api/courses/[id]/draft { feedback? }`: start (re)drafting.
- `POST /api/courses/[id]/approve`: approve the current draft.
- `/api/courses/[id]/materials` (+ `/[materialId]`): same contract as the chat materials routes.
- `POST /api/courses/[id]/sessions`: see §4.
- `GET /api/graph` also carries the skills layer (`skills`: held skills, their arrows, one region per course).
- New server event **`courses-changed`** (course record changed, or a course chat's turn settled) → the sidebar and course page refetch.

**Course evidence cache.** To avoid re-parsing every course chat transcript on each sidebar or course-route read, `src/server/courses.ts` caches each chat file's derived course evidence (course link, skill events, lesson finish note, concluded problems, and conclude calls) in a process-shared, version-keyed LRU map validated against the file's `mtimeMs`, `size`, and `ino`. Capacity starts at a 1,000-entry floor, scales dynamically to `ceil(courseChats * 1.25)` during scans so larger data directories do not thrash, and is bounded by a 20,000-entry ceiling; deleted or unlinked chat files are pruned on scan. **Limitation:** a same-size in-place rewrite that preserves the file's modification time (for example `rsync --inplace -t`) is not noticed until the file changes again; the app's own writer and sync engine write a temporary file and rename it, which changes the inode and invalidates the entry immediately.

## 6. UI

- **Sidebar → Courses** (above sessions): one row per course with its title and a meta line, plus
  "+ New course". The new-course row creates "Untitled course" and
  opens its page. Session rows from a course show the course name as a small
  label.
  - **Folders (owner, 2026-11-14).** The list is courses with no folder (by name), then one collapsible header per
    folder ("2026-2 Høst · 3", highest name first), its courses by name. The whole section collapses too
    ("Courses · 7"); open or closed is remembered per device in `localStorage` (`lh:courses-open`,
    `lh:courses-closed-folders`), not synced. A course moves through **Folder** — the third swipe action, or the
    right-click / long-press menu (Rename, Folder, Delete…) that mouse and stylus now have too: the list holds the
    folders in use (✓ the current one), "No folder", and "New folder…" (a name box; names sort, so "2026-2 Høst"
    sits above "2026-1 Vår"). A folder header's right-click / long-press menu has **Rename folder** (merges into a
    folder of the new name) and **Remove folder** (its courses leave it; none is deleted). With a mouse, dragging a
    course onto a folder header moves it, onto the "Courses" header takes it out (fine pointers only, so it never
    meets the touch swipe). The list scrolls in a box capped at 35% of the window height, so the sessions keep
    their room. The sidebar's "Search sessions…" also filters courses by title or folder name, opening every folder
    with a match.
  - **The meta line (owner, 2026-11-14)** has three left-aligned columns: the progress percent, the days to the
    exam ("12 d", "today", "passed"; the column stays empty without an exam date, so the percent and the days line up
    from row to row), then "4 due", which is left out at 0. While the skill map drafts the line reads "drafting…";
    a draft waiting for review or a failed draft keeps its own words; a course with no skill map shows no line.
  - The session list puts finished sessions (✓) in a collapsed "Finished · N" group at its bottom
    (`lh:finished-open`, per device); searching opens it.
- **`/course/[id]`**:
  - Header: the editable title, *n/m known* and the **Review (n)** button. The title is large (30 px) and never clips (`components/fit-title-input.tsx`): it shrinks to fit its width down to 16 px, and only a title still too long there wraps, onto up to three lines.
  - **Course settings (owner, 2026-11-14)** — one closed line under the header (`components/course-settings.tsx`) holding
    what is set up rarely: the pace, the curriculum (Sources, language, **Draft / Re-draft skill map**), the exam
    date with **Clear** and **Weigh again** (with what the last weighing found, as one line cut at the edge; a mouse hover shows all of it, a touch screen does not), and the **Placement test**. It
    opens by itself while the skill map is missing, drafting, failed or waiting for review, since the curriculum
    controls are then the whole page. The old time note field is gone (the teacher gets the exam date and the days
    left from the exam date instead).
  - **Next up and Exam, side by side** (`components/exam-plan.tsx`): Next up on the left: the review due, **Learn today** (the lessons that hold the pace), **More to learn** (the next four skills by exam priority, each with its own Learn button, so a bulk session starts without opening a row) and, with several skills being learned, a **Practice · n learning** row; left out when there is nothing to do, the exam card on the right: the days left as one big figure ("30 d",
    "today", "passed") with the date, the exam readiness score (below: the percent, a bar with a tick where the foundation and the
    most tested skills end, and "based on 3 past exams"), the skills left, the forecast, and — once weighed — one line, "Skills weighed
    by exam importance." Without an exam date the card holds the date field; before the course is weighed it holds
    **Weigh by exams**.
  - Right after approval, while the course has no sessions: **Find your starting point** — Take the placement test / Start from the beginning (the skip is remembered per browser).
  - Curriculum: the existing Sources control (materials-control) bound to the course, plus **Draft skill map**.
  - Draft state: the draft's summary, its skills (reused ones marked, with citations and prerequisites), a feedback box with **Ask for changes**, and **Approve**.
  - **Active state: the overview and one list (owner, 2026-11-14).** Below Today and Exam:
    - **Understanding · p%** — one bar of the skills spread over four bands (not learned, under 3, 3 to 6, 6 and up) with each
      band's count printed on its segment, the bands as labelled chips, and "n due of m". A band narrows the list to the matching skills.
    - **Reviews due** — its own box right below: four equal columns of when reviews fall due (Now, Today, This week, Later), each with its count and a thin bar sized to the biggest. A bucket narrows the list to the matching skills,
      weakest first, with a clearable "Showing" chip; clearing it brings the groups back.
    - **Skills · n** with a **Choose skills** button and a **Map** button. **Choose skills** turns every learned or next-up
      row into a tick box (a tap ticks instead of opening; locked skills cannot be ticked) and shows a bar at the bottom
      of the window, "3 skills chosen · Cancel · Practice 3", which starts one practice session on the ticked set.
      **Map**: the dependency diagram (white known, learned or next up, gray locked) opens
      fitted to the whole map, with zoom, fit and expand; it hides again from the same button.
    - **Heading ranks (owner, 2026-11-14).** Attention follows rank (`components/section-heads.ts`): the page title, then the
      blocks the page is made of (Next up, Exam, Understanding, Reviews due, Skills, Sessions, a draft) in one large
      heading style, then what sits inside a block (the skill groups under Skills, the groups in Course settings) in
      a small muted one, then a skill's own name.
    - **One grouped list**, two columns on a wide page: **Due for review** (with Review), **Next up**, **Not examined**
      (closed), **From another course**, **Learning** (with Practice all), **Known**, and **Locked · n** as one closed
      group at the end. Each skill is one quiet row: its name, a thin understanding bar (tick at the known line, hatched
      when locked) and a sky dot when it is due. A tap opens the detail (owner,
      2026-11-14: figures and chips, not sentences): the buttons (Learn / Practice / Learn again / Quick check; a known
      skill can be practiced too), then three figures with a one-word label (**understanding** 1.4/10, **recall** 65% with
      a small meter and the 90% review line, **due** now / tomorrow / 3 d), the skills it **needs** as chips with a check
      (learned) or a lock (not yet), the **exam weight** as four 0-3 buttons with a few words on what the weight means
      (and "counts as 3" when what it unlocks counts higher), the statement cut to about two lines, and **More ›**, which
      opens the rest: the full statement, what set the weight and why, the last lesson with a link, and the propositions it
      rests on (name + statement, with links to the sessions they came from). A skill not yet learned shows "Not started" or
      "Locked" instead of the figures. There
      is no Sections / By understanding switch, sort, or filter pills any more.
- The home canvas is unchanged.

## 7. Docs and tests

- Docs: this file (status → as-built), `architecture.md` (Courses store, skills
  ledger owner, new routes/event), README (a "Courses" section),
  `skills/learnharness/references/data-format.md` (skills.jsonl, courses/).
- Tests (deterministic, no LLM): the mastery fold (every row of the §2 table,
  due logic, placement prerequisite credit, views), skills ledger merge and
  dead-reference filtering, course store, draft validation and approval (reuse,
  link-append, DAG/scope rejections), the planner's submit validation, the
  `problem` tool's `skills` field (present/absent, rejection), session creation
  per mode (marker, link, title), materialsForTurn with course materials, and
  render tests for the sidebar section and the course page states.
- Gates: `npm run typecheck`, `npm run lint`, `npm test`.

## As built — differences from the plan text

- **Skills ledger port:** a separate `SkillStore` port (`src/store/skills.ts`) instead of new `GraphStore` methods. The file is the same (`data/graph/skills.jsonl`, under the graph format stamp). Adding methods to `GraphStore` would have broken every in-memory fake that `satisfies GraphStore` in the tests.
- **Placement, solved with hints:** box ≥ 1, prerequisites not credited (owner decision during the build).
- **Reused skills' prerequisites:** when a draft reuses a skill that already requires other skills, approval adds those prerequisites (transitively) to the course's skill set, so no course skill is locked behind a skill the course doesn't show.
- **Planner prompt:** inline in `course-planner.ts`, like the other sub-agents (extraction, material profiler), not a `prompts/course-planner/` fragment directory. That directory would have entered the prompt-override settings, which only cover the conversation agents.
- **Skill map rendering:** the app's own plan DAG renderer (`PlanDiagram`, dagre — mermaid's layout engine), with known skills white, next up white and locked gray, instead of a raw mermaid chart. Box state is shown in the lists below the map.
- **Course context marker:** reuses the `graph-context` marker type (same flattening, neutral input cause and compaction handling) with a `course` block in its details. The transcript card shows the course, mode and skills.
- **`courses-changed`** carries no payload (like `chats-changed`): pages refetch on it, and on every `turn-settled`.
- **2026-10-25 — the learner marker** for Finish lesson is a new marker type (`lesson-finished`, learner cause) rather than a user message, so the transcript shows a divider and the record says exactly what happened.
- **2026-10-25 — the placement probe's skill** must be an exact course skill id (refused otherwise, with the id list); names are not resolved, so the record always carries canonical ids.

## Source catalog (owner, 2026-11-19)

**Problem.** Every tutor turn's system prompt carried the full profile (400-1200 words) of every ready source. Matte 1 has 27 slide PDFs, so that was about 35-40k tokens per turn (estimate), most of it irrelevant to the skill at hand. Search and read always use the original files and are unchanged.

**Design.** The profile is already the index (built once, in the background, when a source is added). Tutor turns (teach, practice, clarify; `materialsForTurn`) now choose by size:
- **Under 24,000 characters** (about 6k tokens) of combined ready profiles: every profile in full, as before.
- **Over it: a catalog.** Each source shows as a catalog entry, cut from its profile with no model call: "Scope and targets" and "Contents" (page references), each section cut to its own budget, Scope 500 characters and Contents 700, so a long Scope never crowds out the page references (`catalogEntry`; a profile without those headings gets its start, up to 1,200). The rules text switches to `CATALOG_RULES`: pick the sources that bear on the lesson and read them.
- **Pinned sources.** A source this conversation has read, through `material_read` or `material_search` with its `material` argument, keeps its full profile (definitions and notation included) every turn. Pins are derived from the chat's stored assistant tool calls each turn (`readMaterialIds`), so chat compaction does not unpin, and nothing new is stored. If the pinned profiles alone pass the threshold, they keep only their entry plus the definitions and notation sections. The first turn is catalog-only; the sources gate forces a lookup before `plan_init`, which pins what it reads.
- The course planner and exam weigher are unchanged: they still get every full profile through `materialBlock`.

**Why pins come from tool calls.** `plan_init`'s `sources` field is free text and is not stored, so the plan cannot name sources reliably.

**Cost to know.** A newly pinned source changes the system prompt once, so that turn misses the prompt cache (the same happens when a source is added mid-lesson).

**Out of scope.** Dropping originals on other devices (Sync source files), a finer per-section index, and cost accounting (profiler spend is already untracked).

## Lecture notes (owner, 2026-11-19)

The learner takes notes during a lecture with the sketch feature, saved in the course; the tutor reads them as extra knowledge of what the course really covered, for a course whose sources are few or vague. Decisions (all owner's): one note per lecture with a date (default today) and a title: the learner's own, or, left blank, `YY.MM.DD - <topic>` ("26.03.12 - Eigenvalues and Eigenvectors") made from the notes once they are read (the date alone before that; the topic comes from the same model call as the lecture's digest, in the course's language; `titleBy` records who set the title, and only an automatic one is ever regenerated or follows a redate); an infinite canvas, not pages; the tutor gets a one-line-per-lecture index in its prompt plus two lookup tools; tutor sessions only (teach, practice and clarify: the planner, the weigher and the drafter read sources only); the notes never satisfy the sources gate.

**Data** (`src/store/lecture-notes.ts`, sole writer). `data/lecture-notes/<courseId>/<noteId>/`: `note.json` (title, date; changes on rename only), `seg-<id>.json` (a SEGMENT of the ink: strokes in write order), `tr-<id>.json` (that segment read to text), `digest.json` (the lecture's one line), `thumb.png` (derived, never synced). `data/lecture-notes/pending.json` is device-local: the notes this device wrote ink for and has not read yet. A stroke carries an optional `id` and `seg` (contracts/sketch.ts); a segment closes at 1,600 x 1,600 px of ink (about one 2,000 px image tile, SKETCH_MAX_EDGE), 400 strokes (from the measured 1.3-2.2 KB per stroke of the owner's Tab sketches: under the 2 MB cap and cheap to rewrite) or a 3 minute pause (the author's number for the owner's "long pause"); on the owner's 114 real sketches of 150+ strokes the rule gives about 250 strokes per segment and the stroke cap closes most (core/lecture-notes.ts `placeStroke`; a stroke's segment is fixed when it is drawn, a pixel cut's pieces inherit it). A segment save is validated for shape and size only (2 MB), never for render limits.

**Saving** (`components/sketch/note-ink.ts`). The canvas keeps the note as one flat stroke list under the note's id; only changed segments are PUT to the device's own server 3 s after the last change and when the note is left; an IndexedDB copy of the unconfirmed segments is kept until the server confirms (a failed save is shown and retried). Notes do not use the browser's storage for ink or the unsent-ink drafts. The shell's stroke wire leaves `id` and `seg` out (its fast reader falls back to a slow one at an unknown key).

**Reading** (`src/server/lecture-note-reading.ts`, `agent/subagents/note-transcriber.ts`). When the learner LEAVES a note the device that wrote its ink reads each segment without a current reading, once, in write order (each call is told how the previous part ended; a segment over the 6-tile render limit is split in write order), on the vision slot, then makes the lecture's digest from the segment digests (one more text call). A reading records the segment file's fingerprint (size and a content hash, cached by modification time), so a changed segment is read again whatever the change; a reading the learner corrected is kept and shown as "ink changed after your correction" (never overwritten). A note left unread (app killed, no vision model) is caught up on the next server start and the next leave. A device that only received the ink by sync never reads: the writer's readings (`tr-*.json`, `digest.json`) sync as well.

**Tutor** (`materialsForTurn`, src/server/materials.ts, the same seam as the sources). A course session's prompt gets `## The learner's lecture notes`: the rules (the sources win on exact wording; the notes show what was covered, stressed and found hard) and a line per read lecture (date, title, digest up to 200 characters), the newest 40, older ones folded into one searchable line. Tools: `lecture_note_search` (regex or literal, hits newest lecture first) and `lecture_note_read` (a lecture or one segment; `image: true` with a segment also returns the handwriting as an image, verified through the claude-code engine's tool bridge 2026-11-19). The wording of the rules is the author's draft, to be confirmed by the owner.

**UI.** A "Lecture notes" row under the Exam card on the course page (components/lecture-notes-row.tsx): a "+" card, then a card per lecture with an ink thumbnail, title, date and a read dot; a card opens the note full screen (`?notes=<id>`), its ⋯ renames, redates or deletes. The note view is the sketch view without Submit, Hint, Steer and Clear; its "Text" button opens what the tutor reads, per segment, editable.

**Lasso and zoom (owner, 2026-11-19).** The sketch view has a Lasso tool on every surface (answers and lecture notes alike): a loop around ink selects it (a stroke is in when half of its points are), then it moves (drag inside), scales (a corner), turns (the top handle), is copied, pasted, deleted or given another colour or width. It is a web layer over the canvas (`components/sketch/lasso-layer.tsx`, a touch hole so the Android shell's pen reaches the page; no shell change), the selected strokes are drawn by the layer while the canvas or the native layer is handed the rest, and each action is one history operation (`transform`, `paste` or the existing erase). Sent (dimmed) ink in an answer sketch can be selected too: selecting leaves it where it is, and the first edit (move, scale, turn, restyle, delete) thaws it into the working page as the eraser's first touch does (copy needs no thaw). The zoom is 0.1x to 8x everywhere (the pen is a width on the page, so zoom cannot change what is written). The shell announces its range (`zoomrange 0.1 8`, in answer to `caps`); until it does, the page keeps every view of the native layer inside 0.5x to 3x, so a new web bundle on an older APK stays correct. The lookup tools and the Text view use segment ids and fingerprints only and never parse a lecture's ink.

**Not verified on a device:** native ink on the Tab with thousands of strokes (open, pan at 0.1x, lasso, save timing), the shell's pen and two-finger gestures through the lasso layer, and the prompt wording of the lecture-notes rules, which is the author's draft awaiting the owner.

## Ask about this class (2026-11-25)

The student wanted to "just be able to ask general questions" inside a class. **Ask** is a course mode (`mode: "ask"`) with its own agent (`src/agent/ask-agent.ts`, prompts in `src/agent/prompts/ask/`): an open conversation that answers briefly, grounded in the class material with page citations. Decided by the design council; the mode keeps the course as the container.

- **Birth.** `POST /api/courses/[id]/sessions { mode: "ask" }` works before a skill map is approved (right after an upload). The chat is an ordinary (teach-kind) chat with the course link `{ mode: "ask", skillIds: [] }` and **no messages**: no context marker and no generated first message, so it opens on an empty composer. Skills, a skill set or `retest` are refused (400). Title "Questions: <course>" until the first question, which then names it (trimmed; a title the learner chose is kept); the course's language is stamped; no learner profile. Creating it does not touch the course record (its `updatedAt` orders Today and the course list).
- **Record version.** An Ask chat is stamped chat schema `3` (`ASK_CHAT_VERSION`, `core/contracts/chat.ts chatVersionFor`) on every write and through sync merges; ordinary chats stay at `2`. Builds without Ask refuse records above `2`, so they never resume an Ask chat as a prober.
- **The agent.** Built through the shared conversation-agent constructor on the session's own model (the teacher's slot); one turn is one conversation turn, with no extra model call. Tools: `material_search`, `material_read`, `lecture_note_search` / `lecture_note_read` when the course has notes, `figure_guide`, `circuit_solve`, `show_figure`, and the background `visual` and `demo` jobs (behind the learner's job-tool toggles). No question, plan, finish, grader or gate, no `read_sketch` (Ask takes no sketch input), no learner-file tools, no plugin tools. A glossary tool has a marked slot in `ask-agent.ts`, not built. Its prompt (`agent/ask-prompt.ts`) is the `ask/` fragments only, no shared fragment (those are written for lessons): the always-on base, answer shape (with its own short voice, accuracy and formatting rules) and grounding, plus one fragment per source or tool that composes only when this turn offers it (class-material lookups, lecture notes, no sources, no tools at all for a selection clarification, drawn figures, circuit solving, `visual`, `demo`). Then Ask's own material and lecture-note sections (the sources listed, no lesson rules), the course section, a line naming the sources this conversation can check, and Ask's language section with the fixed wording (coverage line, unchecked line, general-knowledge label) in the course's language. All fragments are editable in Settings → Agent → prompts ("Ask"). Context admission and compaction charge Ask's own prompt size, and its compaction summary keeps the questions, the answers' claims with their sources and pages, and pending figures.
- **Nothing leaks.** `skillEventsOf` returns nothing for an Ask chat whatever its transcript holds, so the fold, readiness, Today, review, lesson notes, misses and the deletion-impact count never see it; `ratingChanges` is null; the learner profile and fold skip it; the finish input is refused; the chat handler attaches no course tool and does not extract (`COURSE_MODE_EXTRACTS`, one entry per mode), the extraction pipeline itself refuses it (`runExtraction`, before any stage or write: the backfill script too), the manual extract route refuses it (409, `running: false`), its coverage reads as none (`sessionCoverage` null), and the source directory (Chains, practice source picking) does not list it. A finish-looking transcript never makes it finished.
- **The course page.** Three cards at the top, **Learn**, **Ask about this class**, **Practice** (`components/course-modes.tsx`). Learn starts the Next up box's first lesson (through the pace dialog); Practice is Practice all; Ask reopens the newest Ask conversation, with **New** for a fresh one. Before a skill map exists only Ask starts, and Learn and Practice say what is needed first (drafting, a draft to approve, a failed draft, or sources to add). Ask sessions are listed under Sessions as "Questions" (not "Ask": the selection pill in a transcript is already called Ask). An Ask session does not hide the placement offer.
- **The chat.** The top bar shows a "Questions" chip, no coverage ring and no Finish button; the composer edge has no Pace control (Difficulty is practice-only already); the empty transcript says what the mode is.
- **Packaging.** `next.config.ts` names `src/agent/prompts/ask/*.md` in the trace include, and `scripts/build-server.mjs` refuses a payload missing any Ask fragment the checkout has.

**Not verified with a real model:** no real model has answered through the Ask prompt yet.

## Vocabulary coverage (2026-11-25, WP5; reworked after reviews 1 and 2)

The owner: "it also skips over some vocabulary and some things and you have to ask again." The class's own vocabulary is now something the app tracks: every **core** term of the class glossary (built from the indexed PDFs, `core/glossary.ts`, `server/material-indexing.ts courseGlossary`) is assigned to a skill or explicitly left out when the class map is approved, each lesson is told which terms it owes, and what was introduced and checked is derived from the transcripts. Code: `core/coverage-items.ts` (the mapping), `core/coverage-ledger.ts` (the ledger, the prompt block, the finish check), `core/learner-seen.ts` and `core/visible-text.ts` (what the learner saw), `server/course-coverage.ts` (the seam), `agent/subagents/term-mapper.ts` (the mapping-only pass), `components/course-coverage.tsx` (the page). Term identity is unchanged: the exact spelling; nothing is merged by rule.

**The guiding rule: a false "introduced" is the costly error** (a term is skipped silently); a false "new" costs one repeated mention. Every uncertain case resolves to "not introduced". **And nothing in one chat may break the class** (review 2): the ledger reads text written by a model and records synced from other devices, so it never throws out of a page load, a lesson turn or a session start, whatever a message contains (see "Bounds and malformed records" below).

**It is information plus one finish refusal.** Nothing about coverage changes mastery, FSRS scheduling, readiness, grades, the exam plan or Today. A class with no indexed core term and no mapping has no coverage behaviour at all: no prompt block, no finish check, no page block.

**Terms only.** Coverage tracks the glossary's **terms**. The digests' concepts (`c_…`, claims and rules) carry no core or supporting tier and are not in the merged class glossary, so they cannot be required and are not items. (Concept coverage is a possible later package.)

- **The record.** `CourseRecord.coverage = { updatedAt, items, links, suggested?, displaced? }` (absent on every existing class). An item is one glossary entry (`entryId`, `t_…`) or one cited sense of it (`sense: { materialId, page }`, the occurrence that defines that sense; key `<entryId>#<materialId>:<page>`), with `name`, and either `skills` (one or more approved skill ids) or `excluded` (a reason; `leftAtApproval` when the student chose "leave N terms unassigned"). `links` groups item keys confirmed as one concept under several names; introducing or checking one satisfies the group. Unlinked suggested duplicates stay separate items. Only core entries must have an item; supporting ones may and never block anything. `suggested` holds a mapping pass's proposed exclusions and links awaiting the student; `displaced` lists the earlier decisions the last approval could not keep, with why. `coverageError` holds why the last mapping pass failed. Example:
  ```json
  { "updatedAt": "2026-11-25T10:00:00Z",
    "items": [ { "entryId": "t_ring", "name": "ring", "skills": ["sk_3f2a"] },
               { "entryId": "t_kernel", "name": "kernel", "sense": { "materialId": "mat_lec4", "page": 9 }, "skills": ["sk_9b1c"] },
               { "entryId": "t_Field", "name": "Field", "excluded": "the slide-title form of field" },
               { "entryId": "t_unit", "name": "unit", "excluded": "left out at approval", "leftAtApproval": true } ],
    "links": [ ["t_OLS", "t_ordinary_least_squares"] ],
    "suggested": { "excluded": [ { "key": "t_ideal", "reason": "not examined" } ], "links": [] },
    "displaced": [ { "key": "t_field", "name": "field", "reason": "its skill is not in the new class map; assign it again" } ] }
  ```
- **Sync.** `coverage` and `coverageError` move with the approval unit (`status`, `skills`, `draft`, `error`; `core/sync-merge.ts`): three-way against the base, so a mapping edit on one device and an untouched unit on the other merge cleanly, and a change of the unit on both devices keeps the newer side and saves the other as a conflict copy with the note "the course's approval state was changed on both devices". **An explicit deletion is a record whose `coverage` is JSON `null`**; a record that merely lacks the field (written by a build without the vocabulary mapping) is not one. When the base had a mapping, one side left the unit unchanged and the other side lacks the field, the mapping is kept if every skill it names is still in the merged skill set (note: "kept the course's vocabulary mapping, which a copy from an older version of the app did not carry"); otherwise the side that has it is saved as a conflict copy with a note. Nothing in this build writes `null` (no path deletes a mapping), so absence always reads as "this writer did not know the field". No schema stamp was bumped. A chat's course link is the newer side's, except that a session's stored listing (`vocabulary`, below) is kept from the other side when the newer side's link lacks it (an older build).
- **Export and deletion** are the record's: the course JSON (`data/courses/<id>.json`) and `GET /api/courses/[id]` carry the field; deleting the course deletes it.
- **The planner** (`course-planner.ts`) gets, when the glossary has core entries, a `<class_glossary>` block held to **one budget of 60,000 characters for the whole block** (about 15k tokens). The small parts are cut first: the list of materials and the list of incomplete materials are each held to a few thousand characters ("+N more"), the suggested duplicate **pairs** (with the reason for each pair, `SuggestedDuplicateGroup.pairs`, because a chained group can join unrelated names) to 150 pairs and 9,000 characters; the core entries get the rest: `id :: name — "definition" (p. N) — pages in Material [material id]` (or "no definition in the material") until 24,000 characters, then by name and pages only, then counted and not listed (they show as unassigned at approval). Tested with 800 core entries, 300 pairs and 800 incomplete materials: the block stays within 60,000. Its draft gains per skill `terms`, plus `excludeTerms` (id and reason) and `linkTerms`. The output is checked against the real glossary (`draftCoverageFrom`): unknown ids are dropped and listed (`draft.coverage.dropped`, shown on the approval screen), an entry may be under several skills, an entry both assigned and excluded is assigned, a linked name the planner did not map takes its group's mapping, and a core entry in neither list is unassigned.
- **Approval** (`approveCourse`, `POST /approve { leaveUnassigned? }`) checks the **current** glossary whether or not the draft carries a proposal: a draft with none (made before the material was indexed) is an empty mapping. Core entries left unassigned refuse approval (409), named, before anything is written; "Leave N terms unassigned" approves with each one excluded as "left out at approval" (in the class's language). A class whose glossary has no core term approves exactly as before. The draft review shows each skill's terms, the unassigned ones with "Assign to…" and "Exclude", the suggested pairs side by side with their definitions and "Same thing" (a link; "Unlink" undoes it), and for a draft with no proposal a line saying so with **Map the class's terms**. Edits: `POST /api/courses/[id]/coverage { target: "draft" | "approved", action: assign | unassign | exclude | link | unlink | remove | remap | dismiss | clear-displaced, … }`; an edit on a draft with no proposal starts one.
- **Re-drafting and re-approving keep earlier decisions** (`carryForward`): every earlier item whose entry still exists is kept as it was, its skills translated to the draft skills that reuse them; a skill the new draft does not carry is removed from the item (an item left with none is unassigned, for the student to assign again); exclusions are kept; a link is kept while two of its names exist. The new proposal fills in only keys with no earlier decision; a proposed link touching an earlier decision becomes a suggestion. **At approval the carry is made again from the approved map as it is then** (review 2): the carry stored with a draft when it was made or edited is advice for the page, used as it is only while the approved map's decisions are unchanged since (a fingerprint, `carriedFrom`); after an edit on the approved map the draft's own proposal is carried into again, and the keys the student changed on the draft (`edited`: assign, unassign, exclude, remove, remap) win over the approved map's item for the same key. A link the student made on the draft between two carried terms becomes a suggestion in that case (shown, not applied). What the draft review shows is what approval would check now. What could not be kept is listed on the page after approval ("Not kept from the earlier map", with OK). On every approval no stale skill id stays in the mapping (`pruneStaleSkills`).
- **Map the class's terms** (`term-mapper.ts`, `{ map: true, target?: "draft" }` on the same route) runs the planner's mapping-only pass on the approved map (offered while terms are unassigned) or on a pending draft. **It may only add assignments**, for keys that have no decision now (no item, or an item with no live skill and no exclusion), to the given skills. It never changes an existing item, never applies an exclusion, never adds or removes a link: the exclusions and links it proposes are stored as `suggested` and shown on the page ("Suggested by the planner"), each with Accept (the student's own exclude or link edit) and Dismiss. The server (`mergeMappingPass`) enforces this, not the page.
- **Reconciliation** is read-time (`resolveCoverage`), so it needs no write and no model call: an item whose entry (or sense) is no longer in the material is **flagged** ("N terms are no longer in the material", with Remove and Remap to…) and counts toward nothing; a core entry with no item is **unassigned** ("N new terms are not assigned to a skill", with Assign to… and Exclude); an item whose skills all left the class map is unassigned too. A rename is one flagged item plus one new unassigned entry. A material being re-indexed drops out of the glossary meanwhile, so its items are flagged until it is back.
- **The ledger** (derived, never stored). *Introduced*: the entry's name or an alias appeared in text the learner saw in a session of the class, and that name is unambiguous in the class (`findTermCandidates` gives one entry, or all candidates are one link group). A sense of a homonym with two or more senses eligible in the session is introduced when its word was seen in the session **and** the learner answered a question of that session tagged with that sense's key (review 2; the tag alone still introduces nothing, the name alone neither sense). *Checked*: an answered (not dismissed, not set aside, not refused) `quiz` or `explain` whose `conceptIds` resolves to the item; the best `level` and whether any answer was graded right are kept (a quiz's recorded answer; an explain's grade is the tutor's `previous` on the next question). **The two are independent: a tag never introduces.** A question tagged with a term it never names leaves the term checked and not introduced ("asked about, never named" on the page and in the prompt); the finish gate treats it as not introduced. Answers pair with the question occurrence they answer through the view's most-recent-call rule, so two legacy questions sharing a call id cannot both take credit from one answer. **Ask conversations count for nothing.**
- **What the learner saw** is one definition, `core/learner-seen.ts`, over the transcript view (`core/view.ts projectView`), and the cards call the same code for what they render (`answeredCardContent` in `components/answered-card.tsx`, `showFigureContent` in `components/artifacts/show-figure-card.tsx`). Counted: tutor prose (text parts, which include `send_to_user` and a posed question's `lead`); a posed question's question and details while it is **the** pending question as the dock computes it (`pendingQuestionOf`, shared with the dock; review 2: a question in a generation that ended in error, abort or a length stop, one the dock cannot parse, and one a later message superseded count nothing, and a retry that poses it successfully counts it once); an answered question's question and details, and for `explain` the committed answer and the key points (revealed with the answer, counted from then); a shown figure's caption, `lookAt` points and, on a demo only, `tryThis`, when the figure exists and was made; a practice problem's statement once the problem went through (its clean result; never from a failed generation). Not counted: multiple-choice option labels (an option is not teaching: a term met only as a wrong option was not introduced); a quiz's explanation behind "Why" and any collapsed `<details>` body (text the learner must open); a dismissed or set-aside question's anything but its question text; a figure that is missing, failed, refused or still running; thinking; refused calls; the learner's own words; plan blocks, context markers, prompts and material excerpts. Every text is reduced to what the screen shows (`core/visible-text.ts`, reusing the read-aloud package's parse stage `displayedMarkdownHast` without its speech vocabulary): a link shows its label, never its URL; images, attributes, footnote marks and `sr-only` text show nothing; inline math shows as itself when it is a plain run of letters and digits (`$R$-module` reads "R-module") and otherwise as one stand-in letter, so it joins the words around it; display math, fenced code and diagrams are blocks with no words; **inline code counts nothing** (an identifier is not a term introduced; it reads as the stand-in letter); bold, italic and strikethrough markers are removed before words are formed, as the screen removes them (`**sub**group` is "subgroup"; the read-aloud package's linear pass `stripLinearEmphasis`, because the parse stage leaves emphasis unparsed); a soft line break inside a paragraph is a space, except that a hyphen ending a line followed by a line that begins with a lower-case letter is a line-break hyphen and joins the halves (`homo-` / `morphism` is "homomorphism"); each block (paragraph, heading, list item, table cell) starts on its own line. **At finish time** the message that calls `finish_lesson` contributes only its own prose: its sibling calls have not settled when the gate runs (pi prepares every call of a message before executing any), so a sibling that will fail and one that will succeed both contribute nothing yet (`messagesSeenAtFinish`); the later transcript scan agrees on a failed sibling and can only count more (a sibling that succeeded), never less. This is kept as it is: a sibling `send_to_user` that names the terms and succeeds still meets the refusal at finish although the later scan counts it, an error toward a false "new" (one repeated mention).

  | Rule | Introduces | Does not |
  |---|---|---|
  | Word boundary, exact spelling | "Every **ring** has a zero.", "The ring's zero." → ring | "string", "rings", "ring2" |
  | Hyphen joins a word; so do an en dash, an em dash without spaces, a minus sign, a non-breaking hyphen and an underscore; a soft hyphen is removed | "Every R-module" → R-module; "sub — ring" (spaced em dash) → ring | "sub-ring", "ring-like", "sub–ring", "sub—ring", "sub−ring", "sub‑ring", "sub&shy;ring", "ring_buffer" → ring |
  | Line-break hyphen | "ring homo-" / "morphism" (next line lower-case) → ring homomorphism | … → ring |
  | Emphasis markers removed first | "\*\*sub\*\*group" → subgroup; "A \*\*ring\*\* homomorphism" → ring homomorphism; "\*\*eigen\*\*value" → eigenvalue | … → group, ring, value; "\*ring\*s" → ring |
  | Inline code | | "`ring.unit()`", "`ring`" → nothing |
  | Longest match | "A ring homomorphism" → ring homomorphism | … → ring |
  | Name ending in punctuation | "Write C++ code." → C++ | "C++foo" |
  | Rendered Markdown, LaTeX | "$R$-module" → R-module; "[ring notes](…)" → ring | "[notes](…/ring)" (the URL); "$\mathbb{Z}$-module" → module; an image's alt; a collapsed details body; a code block |
  | Whitespace, Unicode | NBSP and a soft line break inside "ring homomorphism"; NFD = NFC; "Blå er", "Ærlig talt" | |
  | Sentence-initial capital (the glossary stores running-text forms) | at a line start (heading, list item, table cell), after ".", "!", "?" or ":" (also "Definition: Ring", quoted) → ring | "the word Ring here" |
  | Stored capitals, all-caps | "Laplace transform" exactly | "laplace transform", "LAPLACE TRANSFORM", "BLÅ" |
  | Ambiguity (exact-one candidate, or one link group) | "entropy" when `entropy` and `Entropy` are linked → both | "entropy" while they are separate entries |
  | Inflection | "resistors" → resistor, only when linked with the entry `resistors` or listed as an alias | "resistors" → resistor otherwise |
  | Alias | "information entropy" (an alias) → entropy | |
  | Symbol | never | "Here H is 2 bits." → nothing |
  | Sense of a homonym | "kernel" when exactly one sense of it is assigned to the session's skills; with two senses, "kernel" seen plus an answered check tagged with a sense's key → that sense | "kernel" alone when two senses are (one skill with both, or a mixed Practice session): neither; a sense-keyed check alone records it as checked, not introduced |
  | Multiple-choice option | | an option label, before or after the answer |
  | Hidden text | | thinking, a refused question's lead, key points before the answer, a quiz's "Why" |
  | Typography | "Ohm’s law" → Ohm's law (quotes read as plain) | "Ohms law" |

- **Reading `conceptIds`** (`resolveConceptId`, used by the ledger and by the turn timeline): an exact item key; an id written with the prompt's brackets (`[t_ring]`); a term's name or alias when it names exactly one item of the class (or one linked group). Anything else is unknown: ignored, counted in the turn timeline (`turns.jsonl` `conceptIds: { tagged, unknown }`, only in sessions of a class with coverage), never refused. The tool descriptions say one thing: with a VOCABULARY list in the course section, its bracketed ids; otherwise the term as the material spells it (which the worked example shows, and which the reader resolves).
- **Cost.** Each course chat's vocabulary evidence is cached per chat file (path, mtime, size, inode, and a fingerprint of the class's names that carries the matching rules' version; bounded at 5,000 files, least recently used out first; entries of chats no longer in the chat list are dropped the next time a class's coverage is read), like the course evidence cache. Measured on a synthetic class (50 sessions of 40 messages with Markdown, a formula and a link in every message, 500 items, M-series Mac, test run): first page load about 375 ms (every text goes through the renderer-faithful parse once), a warm one about 11 ms; plain one-line text skips the parser. A changed chat is scanned again alone, and new names (a re-index) re-scan each chat once.
- **A lesson owes only what it was shown.** When a Learn session (or a Practice session on one skill) starts, the items its prompt lists are chosen (`listVocabulary`, at most **12**: a lesson teaches one skill in about half an hour, a new term every two or three minutes is already dense, and a longer checklist stops being one the tutor can keep in view; **no term is starved**, review 2), in this order: (1) core terms never listed to an earlier session of this skill and not introduced, in the order the material introduces them; (2) core terms listed before but still not introduced (deferred or ignored), fewest earlier listings first; (3) core terms introduced but not checked, oldest first, with **at most 4** of the 12 places while any term of (1) or (2) is waiting; (4) supporting terms still open, with what is left. Practice sessions of the skill take part in this rotation exactly as Learn sessions do (their listings count as earlier listings); only `finish_lesson` has a gate. Example (20 core terms, each lesson names its listed terms and tags no check): lesson 1 lists terms 1–12; lesson 2 lists 13–20 and four to check (1–4); the page reads 20 of 20 introduced after lesson 2. A tutor that defers everything still sees all 20 listed within two sessions, and a skill of 60 terms is listed through in five. Their keys are stored with the session on its course link (`ChatCourseLink.vocabulary`, fixed at birth like `retest`). Every turn reads them back, so what a lesson owes never drifts with later sessions; a session started before the class had a mapping was listed nothing and owes nothing. The course section's VOCABULARY block lists those items with their `[id]`, the material's definition and page, their state (new; asked about but never named; introduced but not checked; with "(carried over)" and, per carried item, how many earlier lessons deferred it), at most four other linked names each, and for a homonym with two senses in the lesson which sense key is which; then how many terms of the skill are left for later sessions (not owed by this one), and the skill's done terms on one line by name. The next session lists the next ones in the order above. The state is as of the other sessions (this session's own progress would change its prompt, and its prompt cache, every turn). No new prompt fragment was added, so the prompt editor and stored overrides are unchanged.
- **Finishing.** `finish_lesson` takes an **optional** `deferred: [{ id, why }]` (absent reads as empty, so a class without vocabulary never pays a schema retry for it; an entry without a non-blank `why` defers nothing). On its own gate, `vocabulary`, outside the turn's total and with an allowance of **one** refusal (`agent/refusal-budget.ts` `OWN_SHARE_GATES`, `GATE_ALLOWANCES`), finishing is refused **once per lesson at most** (decided from the transcript) when a listed core item is neither introduced (in any session of the class, this lesson included) nor deferred. It checks exactly the listed items and names every one it checks: "Refused (vocabulary): this lesson owes 2 core terms of the class that have not been introduced yet (named where the learner sees it, in this lesson or an earlier one; a question tag alone does not count): ring [t_ring], unit [t_unit]. Work the next one in where it belongs to what you just taught, and list the others in `deferred` with a few words of why each waits; then call `finish_lesson` again. This check refuses once per lesson." It never fires for supporting items, flagged items, a class without coverage, or twice; it never spends a refusal of the final-problem requirement. A finish refused only for vocabulary is not counted as a finish attempt by the final-problem gate (`core/final-problem.ts`), so its final problem still stands; nor is a sibling `finish_lesson` in the same message (two calls in one message are one attempt). **Two `finish_lesson` calls in one message get the same vocabulary refusal** (review 2): the allowance of one is per lesson, counted in settled refusals, and both calls are prepared before either result exists, so they are one refusal event shown to both; the next message's finish passes. There is no refusal for repeated deferral; the count shows in the prompt and on the page. Introduced-but-unchecked and deferred items carry into the next session; they never block.
- **What the student sees.** The lesson result card: "Covered 9 of 11 terms; 2 left for next time: …" (Norwegian too), recorded in the clean finish's result when the lesson ends (`details.coverage`), so later lessons never change it. The course page: in a skill's detail "terms: 9 of 11 introduced, 6 checked" (an "asked" term counts as checked, not introduced), which opens the list (state, level, how many lessons left it for later, definition, page); above the skill list, "N new terms are not assigned to a skill · N terms are no longer in the material" with their actions, "Map the class's terms", the planner's suggestions with Accept and Dismiss, and what the last approval could not keep. Labels in `core/lesson-labels.ts` (English and Norwegian).

- **Bounds and malformed records** (review 2). A text is not parsed at all, and counts nothing, when it is longer than **5,000 characters**, or **2,000** when it has a legacy TeX delimiter (`\(`, `\[`) or a double backslash, or when it nests deeper than **100** levels (block markers at one line's start plus open HTML tags) (`core/visible-text.ts`). The limits come from measurement (warm, best of three): the slowest shapes are a GFM table (a 5,000-character wide one about 40 ms; 8,000 characters 90 ms) and unclosed `\(` (the display's delimiter repair is quadratic: 2,000 characters about 36 ms, 4,000 about 125 ms; the reviewer's 40 KB took 11 s, a 240 KB table 16 s); the parse libraries overflow the stack between 500 and 1,000 levels of nesting (the reviewer's 5,000 `>` or `<div>` crashed the page). Ordinary tutor text costs about 1 ms per 1,000 characters and is far below the limits (fixtures: median 290 characters, 99th percentile 3,800); dollar math is not in the TeX tier. Any other failure to reduce or match one text counts nothing for that text; a chat whose record cannot be read, or whose fold fails, counts nothing and is logged once (its id and the error's name, never its text). Results stay cached per chat file, so a cost is paid once per change. Every stored value the package reads is read defensively (`core/coverage-items.ts` readers): `ChatCourseLink.vocabulary` only as an array of non-empty strings (anything else is absent: the session owes nothing, as an unlisted one), its `skillIds` likewise ([] otherwise), `CourseRecord.coverage` and `CourseDraft.coverage` only as objects with an `items` array (otherwise absent), each malformed item, link, suggestion or displaced entry dropped on its own; question records, `conceptIds`, `level`, `deferred` and the finish's recorded line are read with their shape checked, and a record that fails counts nothing.

**Not verified with a real model:** no real model has mapped a glossary, tagged `conceptIds` with item ids, or met the finish refusal yet.

## Not in v1

Skills on the home canvas · editing individual skills by hand after approval ·
a real understanding model (the box rule is the stand-in) · teach-session
quizzes moving boxes · boxes from non-course practice.
