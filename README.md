# code-factory

[![CI](https://github.com/sean85120/code-factory/actions/workflows/ci.yml/badge.svg)](https://github.com/sean85120/code-factory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Claude Code](https://claude.com/claude-code) plugin that turns a repository
into a small software factory. You decide **what** to build and **how** once, in
an interview. After that Claude implements every item on its own branch, has an
independent agent review it, opens a pull request, waits for CI, merges, and
moves on. When the list is empty it reads your open GitHub issues with you,
turns the ones worth doing into new items, and goes again.

```
 ✓ 1 Design    you answer questions; the plan is written to .factory/
 ✓ 2 Approve   you check the plan; nothing runs before this
 ● 3 Build     branch → tests → review → PR → CI → merge, item by item
 ○ 4 Iterate   triage open issues, plan the next phase, repeat
```

> **Status: early.** code-factory uses Claude Code's plugin hooks module, an API
> that is marked early access and may change between Claude Code releases. The
> test suite is verified in CI against a pinned Claude Code version (see
> [`ci.yml`](.github/workflows/ci.yml)). Expect rough edges, and read
> [Safety](#safety-and-trust) before you let it loose on a repository you care
> about. This project is independent and is not affiliated with or endorsed by
> Anthropic.

## Contents

- [Requirements](#requirements) · [Install](#install) · [Five-minute start](#five-minute-start)
- [The interface](#the-interface) · [Triage, fix, repeat](#triage-fix-repeat) · [Commands](#commands)
- [Settings](#settings) · [Files it writes](#files-it-writes)
- [Safety and trust](#safety-and-trust) · [Cost](#cost)
- [Contributing](#contributing) · [License](#license)

## Requirements

- **Claude Code 2.1.275 or later** (a terminal session, for the install command).
  The test suite is run against 2.1.295 in CI and was also run on 2.1.322.
- `git`, with a repository whose `origin` is on **GitHub**.
- The [`gh` CLI](https://cli.github.com), signed in (`gh auth login`) with
  permission to open and merge pull requests in that repository.
- A **test command** for the repository. A build command and end-to-end tests are
  used when you configure them. CI on GitHub Actions (or any check that reports
  on the pull request) is what the factory waits for before it merges.
- A **review command** is optional, unless you set `requireReview` to `false`
  (not recommended): the independent reviewer runs the slash command in the
  `reviewCommand` setting (default `/review-fix`) when it exists, and holds its
  findings to the review rules built into the plugin (severity rubric, security
  pass on sensitive paths, size thresholds, circuit breaker). If the command
  does not exist the reviewer reviews and fixes the branch itself; it reports
  `unavailable`, and the loop pauses, only when it cannot review at all.

`/factory-doctor` checks the setup (git, `gh`, the design files, a clean tree)
and says what to fix.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install code-factory --marketplace sean85120/code-factory
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install code-factory --marketplace sean85120/code-factory
```

To run a working copy instead, clone the repository and start Claude Code with
`claude --plugin-dir /path/to/code-factory`.

## Five-minute start

Open Claude Code in the repository you want built, then:

1. **`/factory`** shows where you are and the one next step, at any time.
2. **`/factory-design`** starts the interview. Claude reads the repo and asks
   about goals, architecture, the tool for each feature, the test, build and
   end-to-end commands, CI, the review command, versions and a spend budget. The
   answers land in three files: `.factory/design.md`, `.factory/todo.md` and
   `.factory/settings.json`.
3. **Push those three files to your base branch.** The factory prints the exact
   commands; it never commits your design for you. (The loop returns to the base
   branch between items, so the files must be there.)
4. **`/factory-approve`** validates the plan and starts the loop. The dashboard
   opens beside the chat.

From here you can walk away. Typing any prompt, pressing Esc, or `[⏸ pause]`
hands the wheel back to you; `/factory-start` carries on where it stopped.

## The interface

- **The band** above the prompt: the current item, a `build → review → PR → CI
  → merge` step row, progress and spend bars, and one line per running agent.
- **The dashboard** (`/factory-dashboard`): the control panel. Start, pause and
  stop buttons, the journey with a plain-language "next step" line, the plan
  with a `[skip]` button per item, blocked items with their reason and a
  `[↻ retry]` button, each agent's recent actions, spend against the budget,
  `[⚑ triage issues]` and `[➜ next phase]` when the loop is idle, and
  `[✔ check setup]`.
- **The status line**: a one-line summary that is always visible.

## Triage, fix, repeat

`/factory-triage [search]` reads the open GitHub issues with you (the optional
text is a GitHub issue search such as `label:bug`). For each one Claude checks
the report against the code, tries to reproduce bugs, and gives a verdict: bug,
feature, needs-info, duplicate or out-of-scope. You pick what to take and settle
how each is fixed; those become `proposed` items carrying `- issue: #12`. Push
the design files and `/factory-approve` promotes them and starts the loop. The
pull request for such an item says `Closes #12`, so merging closes the issue.

When every item is merged the factory starts the next-phase interview by itself
(`/factory-roadmap`, setting `askNextPhase`), and that interview also offers the
open issues as candidates. Approve, and the loop runs again.

Issue text comes from outside your session, so it is treated as a report to
analyse, never as instructions, and nothing from an issue is built until you
have approved the item it became.

## Commands

| Command | What it does |
| --- | --- |
| `/factory` | Where am I, what is next, the command list |
| `/factory-design [topic]` | The design interview (run again to amend the plan) |
| `/factory-approve` | Validate the plan, promote proposed items, start the loop |
| `/factory-start`, `/factory-pause`, `/factory-stop` | Run or hold the loop |
| `/factory-triage [search]` | Turn open GitHub issues into proposed items |
| `/factory-roadmap` | Plan the next phase once nothing is left to run |
| `/factory-dashboard [off]` | Open or close the control panel |
| `/factory-status`, `/factory-log [ID]` | Progress and the event timeline |
| `/factory-costs [repo\|all]` | Spend per repository and per item |
| `/factory-skip <ID> [reason]`, `/factory-retry <ID>` | Set an item aside, or bring it back |
| `/factory-doctor` | Check that git, gh and the design files are ready |

## Settings

The interview writes `.factory/settings.json`; you can edit it by hand and
re-run `/factory-approve`. Settings are part of the approval, so changing one
pauses the loop until you approve again (`reviewTimeoutMs`, `budgetUsd` at its
default and `askNextPhase` at its default are the exceptions).

| Setting | Default | Meaning |
| --- | --- | --- |
| `baseBranch` | `"main"` | Branch pull requests merge into. The design files must be on it. |
| `testCmd` | required | Test command as an argv array, e.g. `["bash","-lc","npm test"]`. |
| `buildCmd` | `[]` | Build command (argv array), run before a pull request opens. |
| `e2eCmd` | `[]` | End-to-end command (argv array). |
| `e2eFor` | `["feature","bug"]` | Item types that need the end-to-end run. |
| `testTimeoutMs` | `600000` | Cap per configured command (at most 10 minutes). |
| `mergeMethod` | `"squash"` | `squash`, `merge` or `rebase`. |
| `maxAttempts` | `4` | Tries per item before it is marked blocked. |
| `maxItemsPerRun` | `0` | Stop after this many merged items in one run (0 is no limit). |
| `allowNoCI` | `false` | Allow merging when the pull request has no CI checks. |
| `requireTestChanges` | `true` | A pull request must change test files. |
| `allowTestRemoval` | `false` | Allow a pull request to delete tests. |
| `requireReview` | `true` | Require a clean independent review for the exact commit. |
| `reviewCommand` | `"/review-fix"` | Slash command the reviewer runs when it exists; the reviewer follows the built-in review rules either way. See [Requirements](#requirements). |
| `maxReviewRounds` | `5` | Review passes before the reviewer stops and the item is marked blocked. `/factory-design` writes `3`. |
| `reviewTimeoutMs` | `1800000` | How long to wait for the reviewer's verdict (at least 60000, at most 6 hours). |
| `contextReset` | `"clear"` | `clear`, `compact` or `none` between items. |
| `stopAfterVersion` | `null` | The loop stops after this version's items are done. |
| `tagRelease` | `false` | Cut a GitHub release when that version is complete. |
| `requireBranchProtection` | `false` | Refuse to approve unless the base branch is protected. |
| `budgetUsd` | `0` | Pause a run once it has spent this many US dollars (0 is no budget). |
| `askNextPhase` | `true` | Interview you about the next phase when everything is merged. |

## Files it writes

In your repository, under `.factory/`:

- `design.md`, `todo.md`, `settings.json`: the plan. **Commit these** to the base
  branch. Each todo item has a type, version, `how` (the decided tool or
  approach), `accept` (acceptance criteria), `tests`, and optionally `depends`
  and `issue`.
- `state.json`, `lock.json`, `blocked/`, `evidence/`: runtime files. The factory
  adds them to `.factory/.gitignore` itself. Do not edit `state.json` or
  `lock.json`; the guards stop the model from doing so.

Outside the repository, spend is recorded in the plugin's own store under your
Claude Code configuration directory (`/factory-costs`).

## Safety and trust

- **Your decisions are frozen.** The plan is hashed at approval; if an item's
  how, acceptance, tests or settings change, the loop pauses until you approve
  again. New work the model discovers is only ever `proposed`.
- **Gates before a pull request opens:** tests changed, no test weakened or
  deleted, a clean independent review for the exact commit (a security pass runs when
  the change touches auth, privacy, deletion, payment, CI workflows or
  installers), build, full test suite, end-to-end tests.
- **Gates before a merge:** every CI check green, the reviewed commit is the pull
  request head, no `--admin`, no force push, no commits on the base branch.
- **Review that scales:** the independent reviewer does a quick pass on a
  one-line fix and fans out to parallel agents on a large change, verifies each
  finding before it counts, runs a separate security pass, and reports bugs it
  finds in neighbouring code apart, so they become proposed items instead of
  widening the pull request. Each pull request gets a short `## Review` section
  as its overview. Nothing in the factory approves a pull request on a person's
  behalf.
- **Stuck is not fatal:** an item that cannot be finished is marked blocked with
  a note, and the loop moves to the next one.

**These guards are best-effort hooks, not a sandbox.** They do not see through
`bash -c`, `eval` or absolute-path commands, the review is another model rather
than a person, and the spend ledger is advisory. Turn on branch protection for
the base branch, set a budget, and read what merges, as you would with any
contributor with push access. Do not point the factory at a repository where you
would not trust the people who can open issues or pull requests. The full list of
limits is under "Guards" in [`CLAUDE.md`](CLAUDE.md). To report a vulnerability,
see [`SECURITY.md`](SECURITY.md).

## Cost

The factory spends model tokens on its own: one or more turns per item, an
independent review (more on large changes) and CI-fix rounds. Spend is tracked per
item (`/factory-costs`, the band and the dashboard). Set `budgetUsd` to stop a
run at an amount you choose; it never interrupts a turn already running, and with a
budget set it pauses rather than run unmetered if the spend cannot be read.

## Contributing

Issues and pull requests are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the setup, the layout of the code and what a good change looks like, and
[`CLAUDE.md`](CLAUDE.md) for the architecture. Please follow the
[code of conduct](CODE_OF_CONDUCT.md). Changes are listed in
[`CHANGELOG.md`](CHANGELOG.md).

```
claude plugin test .       # the test suite
claude plugin validate .   # manifest and hooks check
```

## License

[MIT](LICENSE).
