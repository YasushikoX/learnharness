# About this fork

This repository is YasushikoX's fork of [TobiasSamsonsen/learnharness](https://github.com/TobiasSamsonsen/learnharness), which is itself a fork of [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist. All three are licensed AGPL-3.0, and so is everything added here.

The goal of this fork is to make LearnHarness work well for studying school classes from class material (lecture slides, textbook chapters, mostly PDFs). It builds on Tobias's courses layer (curriculum to skill map, placement test, learn/practice/review per skill) and on upstream's teaching engine. `README.md` below this notice is still Tobias's and describes his additions; this file lists what this fork changes on top.

It is not affiliated with or endorsed by either upstream project. It publishes no builds; run it from source (see `docs/development.md`).

## Changes in this fork

Status as of 2026-11-25. "Landed" means merged to `main` with tests passing; "In review" means written on a branch and under review; "Planned" means designed but not started. This table is updated as work lands.

| Change | What it does | Status |
|---|---|---|
| Merge upstream v0.7.0 | Brings in upstream's session folders, faster transcript opening, editable agent prompts and provider fixes, keeping all of Tobias's features. Deleting a session or folder now warns when it would take course progress with it | Landed 2026-11-24 |
| Whole-document indexing | Splits a converted document into bounded batches and indexes all of it (summary, vocabulary with definitions and pages, concepts, figures) instead of skimming; builds a class glossary | Landed 2026-11-25. Term identity is the exact spelling; nothing is merged by rule, likely duplicates are only suggested |
| PDF converter options | A converter interface with built-in choices: the built-in reader (no setup, also the fallback), a self-hosted Docling service, and Mistral OCR. Every converter yields the same page-marked Markdown, with page numbering owned by the app | Landed 2026-11-25: interface, built-in reader, Docling, and a Mistral OCR preset that has not yet been tested against the real service (marked unverified in Settings) |
| Bring your own PDF service | A service that is not built in is described by a small JSON profile (request, optional polling, where the text is in the reply) that the app interprets; no downloaded or generated code runs, and keys stay in the local credential store. Nothing is sent to a service until its address and key are saved and "Use for new PDFs" is pressed; a built-in Test checks page placement on two bundled PDFs | Landed 2026-11-25 after two security reviews |
| AI-drafted connector | In Settings → PDF conversion, "Draft a connector with AI" writes a profile from the service's documentation (fetched once, or pasted) in one model call; the model sees no key and cannot set the service address. Every value the connector would send is listed and must be acknowledged for that exact version; the app tests it on two bundled PDFs before it can be approved | Landed 2026-11-25 after three security reviews. Not yet tried with a real model or a real service |
| Ask mode | A third entry point on a class next to Learn and Practice: general questions answered from the class material with page citations, with no effect on grades or mastery | Landed 2026-11-25 |
| Vocabulary coverage | Every core term must be mapped to a skill or explicitly excluded when a class map is approved; a ledger tracks which terms were introduced and checked and carries gaps into the next session, shown in the lesson result and on the course page. Refusing a lesson's finish once when it skipped a listed core term without deferring it is an opt-in setting, off by default, until a trial with a real model measures its false refusals | Landed 2026-11-25 after three reviews. Not yet tried with a real model |
| Written answers and harder questions | Written answers by default for concept checks, graded against key points committed in advance; multiple choice kept for predictions, misconception traps and placement (the "Multiple choice" setting goes back to all multiple choice); each question records a difficulty level; one shared refusal budget for the tutor's checks | Landed 2026-11-25 |
| Explained visuals | Every figure carries a "what to look at" note and every simulator a "what to try" | Landed 2026-11-25 |
| Reply reliability | Stream keepalive, a visible notice with Continue when a reply is cut off, Retry after a dropped stream (also after a server restart, and safely from a second tab), a per-turn timing log that records when each turn starts and how the Claude Code CLI ended it, so a turn that hangs leaves a trace (`node scripts/turn-timeline.mjs`) | Landed 2026-11-25 |
| Conversation-switch speed | Caches the per-class evidence scan, removes the repeated full-transcript downloads on every switch (settings-only reads instead) and serialises settings saves. Data per switch drops from about 3 MB to about 25 KB; the visible delay is mostly rendering and is far smaller in a production build than in dev mode | Landed 2026-11-25 |
| Read-aloud | A Play/Stop control beside each question using system voices | Landed 2026-11-25 |
| Confidence slider | The 0–100 confidence slider back as a setting | Landed 2026-11-25 |
| UI redesign | System font for the interface (SF Pro on macOS, Inter elsewhere) with Source Sans 3 kept for lesson text; one type scale, one control system (28/32/36 px heights, 6/8/12/16 px radii, one button family); neutral Light and Dark themes as the default (the previous palette stays as the Warm Brass preset; all presets and overrides keep working); one centred reading column for lesson text, figures and the question card; redesigned class page, Today, sidebar, top bar and Settings; visible keyboard focus. Scored by a four-model design council in screenshot rounds: 4.2/10 before, 7.1 after round 1, 7.6 after round 2 | Landed 2026-11-25, released in 0.7.0-fork.2 |

## How it is built

Changes are designed, written and cross-reviewed by AI coding agents (Claude, GPT, Gemini, Kimi) under the owner's direction. Each change is written by one model and reviewed by a different one before it lands.

## Credits

- Amos Blomqvist for LearnHarness.
- Tobias Samsonsen for the courses fork this is based on.

## Building installers and publishing a release

Actions → **Build installers (fork)** → Run workflow, with a build number. It builds the Windows installer and the macOS app on the owner's self-hosted runners (label `lh-build`); the packaged app's version is `<package.json version>-fork.<build>`. With **publish** off the installers are only attached to the run. With **publish** on, and after both builds pass their checks, a public release `v<version>` is created with the installers and the update metadata; notes come from `docs/fork-releases/<version>.md`. A release is published when a round of changes is finished, not for every build.

Installed copies look for updates in this repository's releases only. Windows copies update themselves from a published build with a higher number; the macOS app is ad-hoc signed and has to be replaced by hand. See `.github/workflows/fork-build.yml` for what runs and for the note on self-hosted runners in a public repository.
