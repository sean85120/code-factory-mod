# Contributing to code-factory

Thanks for helping. This is a Claude Code plugin written in TypeScript; there is
no build step, bundler or `package.json`.

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md). By
contributing you agree that your work is released under the project's
[MIT license](LICENSE).

## Getting set up

You need [Claude Code](https://claude.com/claude-code), `git`, and for the full
workflow the [`gh` CLI](https://cli.github.com).

```
git clone https://github.com/sean85120/code-factory
cd code-factory
claude plugin test .          # every tests/*.test.ts, about 40 seconds
claude plugin validate .      # manifest and hooks check
```

CI runs exactly those two commands, pinned to the Claude Code version in
`.github/workflows/ci.yml`. Both work in a fresh clone with no login.

To try your change in a real session, load the working copy:

```
claude --plugin-dir /path/to/code-factory
```

The plugin hot-reloads when files change. Once it has loaded, the runtime writes
its type declarations under `.claude-plugin/types/` (not committed), and
`tsc -p .` type-checks the module. Run it before you push; CI cannot, because
those types come from a live session.

## How the code is laid out

Read [`CLAUDE.md`](CLAUDE.md) first: it is the architecture and trust model. In
short:

- `hooks/lib.ts` is **pure logic**: parsing, validation, guards, prompts, ledger
  arithmetic, view building. No engine calls. Everything testable lives here.
- `hooks/register.tsx` is the **engine glue**: slash commands, the loop driver,
  the guard hooks and the UI. It must stay one file (a plugin has one hooks
  module).
- `types/index.d.ts` is the `$.state` contract and the view types.
- `tests/*.test.ts` test `lib.ts` directly or drive the hooks through mocked
  engine calls.

## Making a change

1. **Open an issue first** for anything bigger than a small fix, so the approach
   can be agreed before you write it.
2. **Put new logic in `lib.ts`** and test it there. Keep `register.tsx` thin.
3. **Add tests** for every behavior change, and a regression test for every bug
   fix. Never delete, skip or weaken a test to get green.
4. **Treat outside text as hostile.** Anything that came from a repository, an
   issue, a commit message, a branch name or CI output and is printed or put in a
   command must go through `stripControls` / `cleanText` / `safeLines` (or
   `isSafeBranchName` for names) so it cannot carry escape sequences or break out
   of a quoted shell command.
5. **Adding a setting** means updating the `Settings` type, `DEFAULT_SETTINGS`,
   `parseSettings`, the JSON example inside `DESIGN_PROMPT`, the settings table
   in the README, the "Settings" section of `CLAUDE.md`, and the tests
   (`parseSettings` and the hash). Settings are part of the approval hash, so a
   new one must leave the hash of existing plans unchanged while it has its
   default: add it to `decisionsHash` only when it differs from the default, as
   `budgetUsd` and `askNextPhase` do, and add a test that pins both cases. A
   setting that should never invalidate an approval (like `reviewTimeoutMs`) is
   left out of the hash entirely.
6. **Changing a prompt** (`DESIGN_PROMPT`, `workPrompt`, `reviewAgentPrompt`,
   `triagePrompt`, ...) needs a test that pins the part you rely on, and a
   mention of the trade-off in the pull request, because prompts are
   instructions to a model, not enforcement.
7. **Update `CLAUDE.md`** when you change how something in the architecture works,
   and `README.md` when you change what a user sees.

Run `claude plugin test .`, `claude plugin validate .` and `tsc -p .` before you
push.

## Pull requests

- Keep each pull request to one change, with a short imperative title.
- The description uses the template's sections: what changed, testing, risk, and
  how to revert. Say plainly what you did **not** run.
- CI must be green. Maintainers review for correctness, safety of the guards, and
  whether the change fits the design in `CLAUDE.md`.

## Reporting bugs and ideas

Use the issue templates. For anything that could be a security problem, follow
[`SECURITY.md`](SECURITY.md) instead of opening a public issue.
