# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`code-factory` is a Claude Code **plugin** (manifest: `.claude-plugin/plugin.json`) that ships a single TypeScript hook module (`hooks/hooks.json` → `./register.tsx`). It implements a design-first autonomous build loop: the person is interviewed once (`/factory-design`), approves the result (`/factory-approve`), then `/factory-start` drives the model through every todo item, branch by branch and PR by PR, until CI-green merge.

## Commands

```
claude plugin test .                 # every tests/*.test.ts, ~1s; takes only the dir, no per-file filter
claude plugin validate .             # manifest + hooks/calls check
```

`validate` warns that the root `CLAUDE.md` is not shipped as plugin context; that is expected, the file is for working on this repo. There is no `package.json`, bundler or lockfile. Types (`claude-code`, `EngineInterface`, `Register`) and the test runner (`claude-code/testing`) come from the Claude Code mod runtime, and `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which the runtime generates once the mod has loaded (not checked in); after that `tsc -p .` type-checks. The plugin hot-reloads in a session, or load it with `claude --plugin-dir <path>`.

## Architecture

Source is split on purpose:

- `hooks/lib.ts`: **pure logic only**, no engine calls. Parsing and validation of `.factory/todo.md` and `settings.json`, the decisions hash, Bash command classification (`classifyBash`), PR/CI/branch-protection verdicts, test-weakening detection, lock semantics, review-marker parsing, and every prompt string (`DESIGN_PROMPT`, `workPrompt`, `nudgePrompt`, `reviewAgentPrompt`, `releasePrompt`). Everything testable lives here.
- `hooks/register.tsx`: the engine glue (`$` = `EngineInterface`). Registers the `/factory-*` slash commands, the loop driver, the guard hooks, and the live band. It must stay one file: a plugin has exactly one hooks module, `$` cannot be passed into functions imported from another file, and the same event cannot be registered twice without a matcher (fold new behavior into the existing handler). Module-level flags (`isFactoryTurn`, `isArmed`, `isAdvancing`) are in-memory; a reload only costs one `/factory-start`.
- `types/index.d.ts`: the `$.state` contract (`code-factory.view`) and the view types. It must be self-contained (no imports); `lib.ts` imports its types from here.

### Loop view (the band above the prompt)

`buildView` (lib.ts) turns the effective items, state and blocked set into a `FactoryView`: the stage pipeline (`build → review → PR → CI → merge`), open todo rows (done ones collapse to a count), and the last three status changes. `refreshView` stores it in `$.state` every 2 s, on `turn.complete`, and from `/factory-status` and `refreshStatus`; the `ui.render` hook on `AbovePrompt` only reads it. The stage is advanced by `markStage` from the Bash hook (commit, `gh pr create`, `gh pr merge`, only when the guard did not deny) and the review Agent hook; it resets to `build` when `current` changes.

Tests in `tests/*.test.ts` import `claude-code/testing` and exercise `lib.ts` directly (`gates`, `guards`, `lib*`, `safety`, `view`, `handback`). New logic should go into `lib.ts` so it stays testable.

### The loop (register.tsx)

`advance()` is the single step function (it skips while `isFactoryTurn` is set, with a 3 h time limit so a turn that never ends cannot stall the loop for good). It is triggered by `turn.complete` (after 800 ms), by `/factory-start`, by a session starting with autopilot on, and by a 5-minute watchdog. Each call: load state → take the lock → check integrity → inspect the current item (marked done in todo.md **and** a merged `factory/<id>-*` PR exists, else re-send a `nudgePrompt`, blocked after `maxAttempts`) → pick the next item (`pickNext`: status `todo`, not blocked, in version scope, dependencies done) → optionally reset context (`/clear` or `/compact`) → `submit()` the work prompt. When nothing is left it optionally has the model cut a release (`tagRelease`) and pauses.

Any prompt the person types themselves, or an aborted/non-`answer` turn, pauses the loop.

### State and trust model (all under `.factory/`)

- `todo.md`, `design.md`, `settings.json`: written by the design interview and committed to the base branch (the design prompt tells the model to commit and push them; `/factory-approve` fetches `origin/<base>` and requires all three there and identical (via `git show`; `todo.md` compared after `promoteProposed`, so approve's own proposed to todo flip does not count as a difference) to the working tree, because the loop returns to the base branch between items and files that exist only on a `factory/*` branch vanish, which pauses the loop with "settings.json is missing").
- `state.json`, `lock.json`, `blocked/`, `evidence/`: runtime files, auto-gitignored by `ensureGitignore`. The model is denied from writing `state.json`/`lock.json` (Edit/Write deny + `touchesFactoryState` Bash check); only the `/factory-*` commands do.
- `decisionsHash` (settings + every non-`proposed` item's id/type/title/how/accept/tests/depends/version, **not** status) is stored at `/factory-approve`. If it changes, the loop pauses until re-approved. This is what stops the model editing its own decisions.
- `done` in todo.md is only trusted if the person approved it as done (`approvedDone`) or the factory verified a merged PR (`mergedIds`); `effectiveItems` demotes anything else back to `todo`.
- Items the model discovers are appended as `status: proposed`; `/factory-approve` promotes them.
- One session per repo runs the loop: `lock.json` with a 30 s heartbeat and 2 min TTL.
- `<!-- -->` comments and fenced code in todo.md are blanked by `stripNoise` (line count preserved) so template examples aren't parsed as items. Item headings must match `## T-001 [feature|bug|chore|docs] Title`; other `##` lines are reported by `todoHeadingProblems`.

### Guards (the `tool.call` hooks)

The Bash hook is the enforcement point and is **best-effort, not a sandbox** (`splitCommands` is a tokenizer, not a shell parser). While the loop is live (`autopilot || isArmed`, approved, lock not held elsewhere) it blocks: pushes/commits on the base branch, force pushes, `gh api` writes to PRs/refs/contents, `-R/--repo`, and PR creation unless the branch is `factory/*` and the gates pass in order: test files changed, no test weakening (`testWeakening` on `git diff -U0`), clean independent review for the current HEAD, build, full tests, e2e. `gh pr merge` requires a `factory/*` PR that is open, non-conflicting, with all checks green (`checksVerdict`), the head equal to the reviewed SHA, and no weakened tests; `--admin` and `--auto` are denied. CI failures are scanned for GitHub billing messages (`isBillingProblem`), which pause the whole loop instead of retrying.

The factory's long instruction prompts are not put in the transcript: `submit()` sends a one-line headline as the user message and holds the full text in `instructions`, which the `prompt.compose` hook appends as a `code-factory:instructions` session-scoped system prompt section (hidden from the user, covered by the prompt cache). A plugin's own `prompt.submit` hook never sees its own submissions, so the `context` field of `prompt.submit` cannot be used for this. Work/nudge/release instructions only attach while the loop is live (`autopilot` or armed); the design interview's (which does not arm the guards, so it can commit to the base branch after the person confirms) persist until a successful `/factory-approve` or `/clear` and are lost on a plugin reload or `--resume` (re-run `/factory-design`, which also pauses a running loop first so the design can be committed to the base branch). The section tells subagents to ignore it, but `prompt.compose` carries no agent id, so that is model compliance, not enforcement.

The `Agent` hook handles the independent review: the work prompt tells the model to spawn one fresh agent with `reviewAgentPrompt` verbatim (tagged `[FACTORY-REVIEW-AGENT]`, compared after whitespace normalization, so editing it is denied). The reply must end with `FACTORY-REVIEW: danger=<n> medium=<n> sha=<HEAD>`; the factory parses that (`parseReviewMarker`) into `state.review`, and `isReviewClean` requires 0/0 and a SHA matching HEAD. Review rounds are capped by `maxReviewRounds`. The reviewer usually runs in the background, so the Agent call only returns a launch acknowledgement: the hook stores its `agentId` (from the structured `status: "async_launched"` result; `reviewAgentId`/`reviewAgentAt`, waited on for `settings.reviewTimeoutMs`, default 30 min, capped at 6 h, which is excluded from `decisionsHash` so changing it needs no re-approval; a second spawn and every `SendMessage` except the reviewer's own are denied meanwhile, including during the launch itself (`reviewInFlight` is a synchronous latch around the Agent hook, so parallel spawns and a foreground review are covered, and a reviewer's `turn.complete` that races the state write waits up to 5 s for it), and on timeout the loop pauses instead of nudging), while it is pending nobody but the reviewer may commit, push or edit code outside `.factory/` (so a clean verdict for HEAD cannot cover commits made after the reviewer read the tree; best-effort: only commit/merge/push-class git commands and the Edit/Write tools are covered, not `git rebase/reset/pull/apply`, shell writes or NotebookEdit; the reviewer's own children are denied too; the wait window is frozen into `state.reviewWaitMs` at launch so editing `reviewTimeoutMs` mid-review does not shorten it, and a verdict that arrives after the window or in a session that did not launch the reviewer is dropped), `advance()` does not nudge, and the verdict is read from the reviewer's own final `turn.complete` (`reviewerTurn`/`decideReviewAnswer`): its `agentId` is pinned by the engine, so no other agent can produce it, and text quoted anywhere else is never parsed. A reviewer that errors or answers with no verdict frees the loop but counts as a round, so respawns hit `maxReviewRounds` and block the item. The agent's `agentId` proves who spoke, not that it was a real reviewer, so the Agent hook also requires a plain `general-purpose` agent (no custom `subagent_type`, `model`, `name`, `mode`, `team_name` or `isolation`) and Edit/Write on `.claude/agents|commands|skills/` and `.claude/settings*.json` is denied while the loop is live (best-effort: Bash can still write files, and a reviewer reading a repo-controlled `CLAUDE.md` is not defended against). The main loop's next turn (the hand-back message) is flagged as the loop's own via `expectReport` whenever the plan is approved, even if the loop was paused meanwhile, so the guards are armed for that turn (`turn.complete` disarms it again when `autopilot` is off). Unverified live: that the Agent tool's `agentId` equals the `agentId` its `turn.complete` carries; if not, async reviews time out and pause.

### Settings

`parseSettings` is the schema (defaults in `DEFAULT_SETTINGS`); `testCmd` must be a non-empty argv array and each configured command is capped at 10 minutes. Adding a setting means updating the `Settings` type, `DEFAULT_SETTINGS`, `parseSettings`, and the JSON example inside `DESIGN_PROMPT`. Settings are part of the approval hash, so changing any of them invalidates a prior approval.
