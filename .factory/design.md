# code-factory: next improvements (dogfood run)

## Overview

code-factory is a Claude Code plugin (plus OpenCode and Codex ports) that runs a design-first autonomous build loop. CLAUDE.md in the repo root is the architecture reference and the trust model; read it before touching hooks/, core/ or codex/. This run uses the factory on its own repository to improve it: a clearer dashboard, a livelier mascot, port parity for the new approve-time design publish, refreshed README screenshots.

## Non-goals

- No change to the trust model beyond what 0.4.1 already did (the model never commits or pushes; only the person's own command does).
- No new settings in settings.json (every threshold is a constant, so decisionsHash is unaffected).
- No text-cursor tracking: the plugin API exposes no prompt cursor position and no pointer outside a pane region.
- No dashboard, band or mascot on OpenCode or Codex (they have none).
- No changes to the issue watcher, spend ledger or loop semantics.

## Architecture constraints (from CLAUDE.md)

- Pure logic goes in `hooks/lib.ts` (testable, no engine calls). `hooks/register.tsx` is the one hooks module; a new surface module file (for `Client`) is a separate mechanism and allowed.
- Text the model or repo controls never reaches the terminal raw: new strings built from fixed words, item ids and numbers only, or passed through `cleanText`/`safeLines`.
- Every glyph, color and bar goes through the `Theme`; classic keeps its existing strings except where an item says otherwise.
- `lib.ts` stays loadable by Node type stripping and Bun (type-only imports, no enums or namespaces). `core/` and adapters import it with the `.ts` extension.
- Tests: `tests/*.test.ts` for the Claude plugin (`claude plugin test .`), `*.spec.ts` with `node:test` for the ports. Typecheck with `tsc -p .` and `tsc -p opencode`.
- Releases: every feature or fix item bumps the patch version in `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `opencode/package.json` and the two lines of `opencode/package-lock.json` (lines 3 and 9, not the json-schema package), adds a `CHANGELOG.md` section for it, and `scripts/check-version.sh` must pass. On macOS use node or python for the edit, not `sed -i`. The person tags and publishes releases by hand.

## Version plan

Each feature or chore item is its own PR and its own patch version: 0.4.2 (docs REVIEW.md and the design prompt chore), 0.4.3 now/why line, 0.4.4 live activity and stuck warning, 0.4.5 mascot gaze, 0.4.6 bigger face, 0.4.7 port parity, 0.4.8 screenshots. The loop stops after 0.4.8. No release is cut by the loop.

## Self-hosting risk

The loop edits the plugin that runs it. The plugin hot-reloads, so a merged item can reload the loop's own code mid-run. Mitigation: items are small and sequential, the loop returns to `main` between items, and `/factory-start` resumes after a reload. A reload that breaks the plugin is caught by the test gate before merge.

## Phase 2: verify and harden 0.4.x

Goal: close the gap between "tested" and "verified live" for the 0.4.x dashboard work, and make the screenshot script fail loudly on bad output. No new product behavior.

Out of scope for phase 2: trust-model changes (guards, approval hash, who may commit or push), token and weekly usage display, new settings, a UI on OpenCode or Codex, changes to the issue watcher, spend ledger or loop semantics, the low review findings sweep and the gaze fallback toast (both offered and not chosen).

Version plan: one patch, 0.4.9. T-009 (docs, no bump, like T-001) then T-010 (chore, bumps to 0.4.9 with a CHANGELOG section). The loop stops after 0.4.9 (`stopAfterVersion`). No release is cut by the loop (`tagRelease` stays off); the person tags by hand.

## Decisions

### Phase 2 scope
- Question: what the next phase builds.
- Options: verify and harden 0.4.x, new product features, low review findings sweep, nothing more.
- Choice: verify and harden 0.4.x, as a live-check checklist doc and a screenshot-script self-check. The gaze fallback toast and the low findings sweep were offered and not chosen.
- Why: the 0.4.5 and 0.4.6 pointer and Client work is unverified live and tests cannot cover it; a written checklist makes the person's live pass cheap. A first look at docs/img showed all eleven files are real PNGs, so no repair is needed, only a guard.

### Live-check doc
- Choice: one page, docs/live-checks.md, facts taken only from CLAUDE.md and the CHANGELOG, linked from README and CLAUDE.md. Docs item: no version bump, no tests.
- Rejected: a runtime self-test inside the plugin (the test harness cannot paint or send pointers, so it would prove nothing) and rewriting the "Unverified live" notes in CLAUDE.md (they are the reviewer's reference, one pointer sentence is enough).

### Screenshot self-check
- Choice: scripts/check-shots.sh, called by demo-shots.sh, checks name list, size over 1000 bytes and the PNG magic bytes with `head` and `od`; exit 1 on any bad file.
- Rejected: pixel-dimension checks (change with every layout change) and the `file` command (not guaranteed everywhere). Stays a local guard because the script needs macOS, Chrome and bun and does not run in CI.

### Phase 2 versions and flow
- Choice: stopAfterVersion 0.4.9, no release, other settings unchanged from the first run (base main, squash, context clear, no budget, askNextPhase on, tagRelease off, watchIssues off).

### Scope of the first run
- Question: which improvements to build.
- Options: port parity, low review findings, README screenshots, other.
- Choice: port parity, README screenshots, and a clearer dashboard plus a livelier mascot (added by the person). The low review findings are left out.
- Why: the person prioritised visible product work over hardening a path that already passed two review rounds.

### Dashboard clarity
- Question: what is unclear today.
- Choice: a plain "now" sentence, why the loop is idle plus the one next action (replacing the misleading "nothing left to do" when items are blocked or proposed), live activity with a stuck warning, and the same wording in the compact band and the status line.
- Why: a real screenshot showed "[HOLD] nothing left to do 9/10 done" while T-009 was blocked and four items were proposed.
- Where: wording is computed in lib.ts from the FactoryView and rendered through the theme in classic and hacker, ASCII tier included.

### Mascot gaze
- Question: which cursor Vox should look at.
- Choice: the mouse pointer while it is over the dashboard pane.
- Why: the plugin API only reports pointer events over a `Client` region; it has no prompt cursor position. Outside the pane or after a few idle seconds Vox returns to today's idle animation.
- Risk: unverified live (the test harness cannot drive pointer events); the pure gaze math and the element tree are tested, and the existing Raster path stays as the fallback.

### Mascot detail
- Choice: a bigger Raster face (terminal, 70+ columns) with sub-cell pupil movement, eyelids, brows and mouth shapes per state, still only space, upper-half and lower-half block glyphs. The ASCII tier and the desktop SVG are unchanged.

### Item order and versions
- Choice: dashboard, then mascot, then ports, then screenshots (screenshots last because the earlier items change how they look). Each PR bumps the patch version; the loop stops after 0.4.8.

### Verification
- Choice: testCmd runs the plugin suite, the port specs and `scripts/check-version.sh`; buildCmd runs `tsc -p .` and the opencode `tsc`. No e2e: nothing here is UI-testable headless. CI (`.github/workflows/ci.yml`) is required and already exists.

### Review
- Choice: `/review-fix` with an independent agent, `maxReviewRounds` 3, security pass when a diff touches the sensitive paths below. REVIEW.md is written by the first item because none exists. Failure means: a guard lets a forbidden action through; the loop overrides the person; spend or state is silently wrong; repo or model text reaches the terminal raw. Skip: `docs/img/*.png`, `opencode/package-lock.json`. Sensitive paths: the guards in `hooks/register.tsx`, `core/factory.ts`, `codex/hook.ts`, `.github/workflows/`. Nit cap: 3.

### Git and flow
- Choice: base `main`, squash merge, context `clear` between items, blocked items are skipped and the loop continues, no budget, `askNextPhase` on, `tagRelease` off, `watchIssues` off, branch protection not required.
- The design files reach `main` through `/factory-approve` (0.4.1 publishes them itself), not through a commit made in the interview.
