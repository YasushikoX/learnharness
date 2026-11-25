# About this fork

This repository is YasushikoX's fork of [TobiasSamsonsen/learnharness](https://github.com/TobiasSamsonsen/learnharness), which is itself a fork of [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist. All three are licensed AGPL-3.0, and so is everything added here.

The goal of this fork is to make LearnHarness work well for studying school classes from class material (lecture slides, textbook chapters, mostly PDFs). It builds on Tobias's courses layer (curriculum to skill map, placement test, learn/practice/review per skill) and on upstream's teaching engine. `README.md` below this notice is still Tobias's and describes his additions; this file lists what this fork changes on top.

It is not affiliated with or endorsed by either upstream project. It publishes no builds; run it from source (see `docs/development.md`).

## Changes in this fork

Status as of 2026-11-25. "Landed" means merged to `main` with tests passing; "In review" means written on a branch and under review; "Planned" means designed but not started. This table is updated as work lands.

| Change | What it does | Status |
|---|---|---|
| Merge upstream v0.7.0 | Brings in upstream's session folders, faster transcript opening, editable agent prompts and provider fixes, keeping all of Tobias's features. Deleting a session or folder now warns when it would take course progress with it | Landed 2026-11-24 |
| Whole-document indexing | Splits a converted document into bounded batches and indexes all of it (summary, vocabulary with definitions and pages, concepts, figures) instead of skimming; builds a class glossary | In final review: term identity is the exact spelling, nothing is merged by rule; the fourth review's findings are fixed (`wp/3c-digest-wiring`) |
| PDF converter options | A converter interface with built-in choices: the built-in reader (no setup, also the fallback), a self-hosted Docling service, and Mistral OCR. Every converter yields the same page-marked Markdown, with page numbering owned by the app | In final review with the indexing branch: interface, built-in reader and Docling (`wp/3c-digest-wiring`); Mistral OCR preset built, not yet tested against the real service (`wp/3a2-http-converters`) |
| Bring your own PDF service | A service that is not built in is described by a small JSON profile (request, optional polling, where the text is in the reply) that the app interprets; no downloaded or generated code runs, and keys stay in the local credential store | In fix round after a security review (`wp/3a2-http-converters`) |
| AI-drafted connector | "Draft with AI" writes that profile from the service's documentation in one model call, tests it on a bundled two-page PDF and shows the result for approval before it can be enabled | Planned |
| Ask mode | A third entry point on a class next to Learn and Practice: general questions answered from the class material with page citations, with no effect on grades or mastery | Landed 2026-11-25 |
| Vocabulary coverage | Every core term must be mapped to a skill or explicitly excluded when a class map is approved; a ledger tracks which terms were introduced and checked and carries gaps into the next session | Planned |
| Written answers and harder questions | Written answers by default for concept checks, graded against key points committed in advance; multiple choice kept for predictions and placement | Planned |
| Explained visuals | Every figure carries a "what to look at" note and every simulator a "what to try" | Planned |
| Reply reliability | Stream keepalive, a visible notice with Continue when a reply is cut off, Retry after a dropped stream, a per-turn timing log | Landed 2026-11-25 |
| Conversation-switch speed | Caches the per-class evidence scan, removes the repeated full-transcript downloads on every switch (settings-only reads instead) and serialises settings saves. Data per switch drops from about 3 MB to about 25 KB; the visible delay is mostly rendering and is far smaller in a production build than in dev mode | Landed 2026-11-25 |
| Read-aloud | A Play/Stop control beside each question using system voices | Landed 2026-11-25 |
| Confidence slider | The 0–100 confidence slider back as a setting | Landed 2026-11-25 |

## How it is built

Changes are designed, written and cross-reviewed by AI coding agents (Claude, GPT, Gemini, Kimi) under the owner's direction. Each change is written by one model and reviewed by a different one before it lands.

## Credits

- Amos Blomqvist for LearnHarness.
- Tobias Samsonsen for the courses fork this is based on.
