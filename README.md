# code-factory

A Claude Code plugin that turns any repository into a small software factory.
You decide **what** and **how** once, in an interview. After that Claude
implements every item on its own branch, reviews it with an independent agent,
opens a PR, waits for CI, merges, and moves on. When the list is empty it reads
your open GitHub issues with you, turns the ones worth doing into new items, and
goes again.

```
 ✓ 1 Design    you answer questions; the plan is written to .factory/
 ✓ 2 Approve   you check the plan; nothing runs before this
 ● 3 Build     branch → tests → review → PR → CI → merge, item by item
 ○ 4 Iterate   triage open issues, plan the next phase, repeat
```

## Install

At the prompt of a Claude Code terminal session (2.1.275 or later):

```
/plugin install code-factory --marketplace sean85120/code-factory
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install code-factory --marketplace sean85120/code-factory
```

The repository you use it on needs `git`, an `origin` on GitHub, and the
[`gh` CLI](https://cli.github.com) signed in. `/factory-doctor` checks all of it.

## Five-minute start

Open Claude Code in the repository you want built, then:

1. **`/factory`** shows where you are and the one next step, at any time.
2. **`/factory-design`** starts the interview. Claude reads the repo and asks
   about goals, architecture, the tool for each feature, the test, build and
   end-to-end commands, CI and versions. The answers land in three files:
   `.factory/design.md`, `.factory/todo.md` and `.factory/settings.json`.
3. Push those three files to your base branch (the factory prints the exact
   commands; it never commits your design for you).
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
PR for such an item says `Closes #12`, so merging closes the issue.

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

## What keeps it honest

- **Your decisions are frozen.** The plan is hashed at approval; if an item's
  how, acceptance, tests or settings change, the loop pauses until you approve
  again. New work the model discovers is only ever `proposed`.
- **Gates before a PR opens:** tests changed, no test weakened or deleted, a
  clean independent review (including a security pass) for the exact commit,
  build, full test suite, end-to-end tests.
- **Gates before a merge:** every CI check green, the reviewed commit is the
  PR head, no `--admin`, no force push, no commits on the base branch.
- **Review that scales:** the independent reviewer does a quick pass on a
  one-line fix and fans out to parallel agents on a large change, verifies each
  finding before it counts, runs a separate security pass, and reports bugs it
  finds in neighbouring code apart, so they become proposed items instead of
  widening the PR. Each PR gets a short `## Review` section as its overview.
- **Budget:** `budgetUsd` in `.factory/settings.json` pauses a run when its
  spend reaches the limit.
- **Stuck is not fatal:** an item that cannot be finished is marked blocked
  with a note, and the loop moves to the next one.

The guards are best-effort hooks, not a sandbox. Turn on branch protection for
the base branch and review what merges, as you would with any contributor.

## Developing

See [`CLAUDE.md`](CLAUDE.md) for the architecture. `claude plugin test .` runs
the suite and `claude plugin validate .` checks the manifest and hooks; load a
working copy with `claude --plugin-dir <path>`.
