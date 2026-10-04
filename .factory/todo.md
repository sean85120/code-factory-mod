# Todo

<!-- Format, one block per item, in priority order:
## T-001 [feature] Short title
- status: proposed
- how: chosen tool/algorithm/workaround and why
- accept: checkable acceptance criteria
- tests: what the tests cover
-->

## T-001 [chore] Add GitHub Actions CI
- status: done
- version: 0.2.0
- how: Create `.github/workflows/ci.yml` triggered on `pull_request` and `push` to main. One job named `test` on ubuntu-latest: `actions/checkout`, `actions/setup-node` (Node 22), `npm i -g @anthropic-ai/claude-code`, then `claude plugin test .` and `claude plugin validate .`. Chosen because the test kit comes only from the CLI runtime; tsc is rejected since `.claude-plugin/types` is generated and not checked in. Pitfall: if the CLI needs auth or fails in CI, record the failure in the blocked note and mark blocked; do not fake a passing job and do not skip tests.
- accept: The workflow runs on the PR that adds it, job `test` is green, and the log shows 'pass' lines from `claude plugin test .` and 'Validation passed'. Workflow fails if any test fails.
- tests: No unit tests (chore). Verify by `gh pr checks` showing job `test` green on the item's PR and by reading the Actions log for the real test count.

## T-002 [chore] Enable branch protection on main
- status: todo
- version: 0.2.0
- depends: T-001
- how: With `gh api -X PUT repos/sean85120/code-factory/branches/main/protection` set required PRs, required status check `test` (strict), no force pushes, no deletions, `enforce_admins` true. Private repo: this needs a GitHub plan that supports it; if the API returns 403/404 plan errors, or the factory guard denies the `gh api` write, mark blocked and write the exact command into the blocked note for the person to run by hand. Do not weaken guards to get around a denial.
- accept: `gh api repos/sean85120/code-factory/branches/main/protection` shows required status check `test`, `enforce_admins.enabled` true, `allow_force_pushes.enabled` false, required PR reviews or PR requirement set. If blocked, the note contains the ready-to-run command.
- tests: No unit tests (chore). Verify by reading back the protection settings.

## T-003 [docs] Write a real README
- status: todo
- version: 0.2.0
- depends: T-001
- how: Replace the one-line README.md with: what code-factory is; install (`claude --plugin-dir <path>`, plugin hot reload); the workflow (`/factory-design`, `/factory-approve`, `/factory-start`, `/factory-status`); the `.factory/` files and the trust model (decisionsHash, approvedDone, locks); the guards and their best-effort limits; a full settings reference taken from `parseSettings` and `DEFAULT_SETTINGS` in hooks/lib.ts; testing (`claude plugin test .`, `claude plugin validate .`). Source every fact from the code; do not invent commands. Add a CI status badge line only if T-001 merged.
- accept: README.md covers every section above; every setting in `DEFAULT_SETTINGS` is documented with its default; every slash command registered in register.tsx is listed; no claim contradicts CLAUDE.md.
- tests: No unit tests (docs). Reviewer cross-checks the settings table against `DEFAULT_SETTINGS` and the command list against register.tsx.

## T-004 [bug] Bash tokenizer: multi-line quotes and backslash continuations
- status: todo
- version: 0.3.0
- depends: T-001
- how: In `splitCommands`/`classifyBash` (hooks/lib.ts, around line 454-482), `let quote` is declared inside the per-line loop so a multi-line quoted string resets at each newline and hides everything after it; a trailing backslash is kept as a token so a continuation line becomes a separate command and loses its flags. Fix by first joining continuations (`command.replace(/\\\r?\n/g, ' ')`) outside quotes, and tokenizing the whole string once with quote/heredoc state carried across newlines, treating a newline as a separator only outside quotes. Rejected: a full shell parser (out of scope; guard stays best-effort).
- accept: `classifyBash('git commit -m "a\nb" && gh pr create','main','factory/x').isPrCreate` is true; `git commit -m "T\n\nbody" && git push origin main` reports push to base; `gh pr create --body "steps:\ngit push origin main"` is NOT a push (no false positive); `git push \` + newline + `origin main` sets `pushNamesBase`; `gh pr merge 5 \` + newline + `--admin` sets `hasAdmin`, likewise `--auto` and `-R o/r`; existing tests still pass.
- tests: Unit tests in tests/ for each accept example (positive and the false-positive case), asserting the specific classifyBash facts.

## T-005 [bug] Bash classification: wrappers, keywords, paths, subshells
- status: todo
- version: 0.3.0
- depends: T-004
- how: `classifyBash` only inspects the first token of each command (hooks/lib.ts around 496-564). Add normalization before classification: skip shell keywords (`if then else elif do while until ! { }`), reduce the command word to its basename (`/usr/bin/git` -> `git`), skip wrapper commands with their flags (`env`, `sudo -u`, `time -p`, `timeout <n>`, `nice`, `command`, `exec`) , and recurse into `bash|sh|zsh -c '<cmd>'`, `eval`, `xargs <cmd>`, `$(...)` and backticks including inside double quotes. Rejected: denying every `bash -c`; recursion keeps legitimate use working.
- accept: Each of these sets the same facts as the bare command: `if gh pr checks 5; then gh pr merge 5 --squash; fi`, `env -i git commit -m x`, `sudo -u root git commit -m x`, `time -p git commit -m x`, `timeout 60 git push origin main`, `/usr/bin/git commit -m x`, `/opt/homebrew/bin/gh pr merge 5 --admin`, `bash -c "git commit -m x"`, `sh -c 'git push origin main'`, `eval "git push origin main"`, `xargs git push origin main`, `out="$(gh pr merge 5 --admin)"`, `echo "$(git push origin main)"`, and the backtick form. Benign look-alikes (`echo git push origin main`, `grep "gh pr merge" file`) stay unclassified.
- tests: One unit test per accept example, plus the benign look-alike cases asserting no facts are set.

## T-006 [bug] Deny every gh api write path
- status: todo
- version: 0.3.0
- depends: T-005
- how: The `apiPrWrite` check (hooks/lib.ts around 586-606) misses `-XPUT` (attached flag), query strings (`...merge?x=1`), `gh api graphql` mutations, PATCH on pulls, and branch-protection PUT. Replace it with a default-deny rule: while the loop is live, a `gh api` call is allowed only when it is a GET (no `-X`/`--method` other than GET, no `-f/-F/--field/--raw-field/--input`, attached forms like `-XPUT` and `-fkey=v` included) and the endpoint is not `graphql`. Update the deny message to say reads only.
- accept: `apiPrWrite` is true for: `gh api -XPUT repos/o/r/pulls/5/merge`, `gh api -X PUT repos/o/r/pulls/5/merge?x=1`, `gh api graphql -f query='mutation{mergePullRequest(input:{})}'`, `gh api -X PATCH repos/o/r/pulls/5`, `gh api -X PUT repos/o/r/branches/main/protection`; false for `gh api repos/o/r/pulls/5` and `gh api repos/o/r/pulls/5 --jq .state`.
- tests: One unit test per accept example (five denied, two allowed).

## T-007 [bug] Guard unhooked tools and pin the review agent
- status: todo
- version: 0.3.0
- depends: T-006
- how: In `hooks/register.tsx` fold into existing handlers (no duplicate event registration without a matcher). (a) Monitor: apply the same Bash classification and state-file check to `Monitor`'s `command` input; while the loop is live deny `Workflow`, `CronCreate` and `ScheduleWakeup` tool calls (they can run unguarded shell/agents). Verify input field names from `.claude-plugin/types/claude-code-tools/index.d.ts`. (b) Agent hook: besides comparing the prompt, require `subagent_type` unset or `general-purpose`, and `isolation` and `model` unset, else deny; keep the reviewer text check but make `parseReviewMarker` require the marker to be the last non-empty line of the reply. Pitfall: the model could otherwise define `.claude/agents/approve.md` that always emits a clean marker.
- accept: While live, `Monitor{command:'git push origin main'}` is denied; `Workflow`, `CronCreate`, `ScheduleWakeup` are denied; when the loop is not live they are untouched. An Agent spawn with the exact review prompt but `subagent_type:'approve'`, or `isolation:'worktree'`, or `model:'haiku'` is denied and `state.review` is unchanged. A marker in the middle of the text does not count; one on the last non-empty line does.
- tests: Hook tests in tests/ using the existing test mock for each accept bullet (denied/allowed, state.review unchanged), plus `parseReviewMarker` unit tests for last-line vs mid-text markers.

## T-008 [bug] Close testWeakening gaps
- status: todo
- version: 0.3.0
- depends: T-007
- how: In `testWeakening` and `hasTestChanges` (hooks/lib.ts around 694-737) fix: (1) an added line that is a comment (`//`, `#`, `/* */`) no longer counts as an assertion; (2) count removed vs added assertions per file, not across the whole diff, so adding tests elsewhere cannot mask removals; (3) extend `SKIPPING` with `test.fixme(`, `@pytest.mark.xfail`, `#[ignore]`, `it.skipIf(`, `self.skipTest(`, `test.fail(`, `it.failing(`; (4) flag diffs that touch CI/test-runner config (`.github/workflows/`, `package.json` test script, jest/vitest/pytest config) unless the current item's title mentions CI; (5) handle git's quoted non-ASCII paths (use `-c core.quotePath=false` on the diff and name-only calls, or `-z`); (6) stop flagging `require`/`import` swaps as lost assertions. Rejected: detecting `toBe(1)` -> `toBeDefined()` weakening (needs semantic analysis; note as known gap in the README).
- accept: Each returns a weakening: commenting out an `expect(...)` line; removing 3 assertions in a.test.ts while adding 3 trivial ones in b.test.ts; each skip marker listed in (3); a diff changing `run: npm test` to `run: echo skip` in `.github/workflows/ci.yml`; deleting `tests/測試.test.ts`. A `-const x = require('x')` / `+import x from 'x'` swap in a test file returns no weakening.
- tests: One unit test per accept example in tests/ calling `testWeakening` with a crafted `git diff -U0` string, and `hasTestChanges` for the non-ASCII path.

## T-009 [bug] Strengthen the approval hash
- status: todo
- version: 0.3.0
- depends: T-008
- how: In hooks/lib.ts (`decisionsHash` around 369-386) and register.tsx (approval around 607-611): (1) replace 32-bit FNV-1a with SHA-256 (`node:crypto` if available in the runtime, else a small pure SHA-256 in lib.ts; check which the runtime supports before choosing); (2) include `design.md` content in the hashed input so editing decisions after approval pauses the loop; (3) `approvedDone` must be previous `approvedDone` union `mergedIds` union only items the person is shown as done at approval, and `/factory-approve` output must list any newly-done items so a model-written `status: done` cannot be silently trusted. Settings stay in the hash. Pitfall: changing the hash invalidates existing approvals; that is expected and the person re-approves once.
- accept: Hash differs after any design.md edit; the audit's collision (`accept` changed to 'Anything goes, no checks needed.' plus the three CJK chars U+4E01 U+491A U+BB8C) no longer collides; a todo item set to `status: done` by the model without a merged PR stays demoted to `todo` across a re-approval and is listed as 'newly done' in the approve output; integrity check pauses the loop after a design.md change.
- tests: Unit tests for hash change on design.md edit, the collision case, and `approvedDone` handling; an integrity test that a modified design.md yields an integrity problem.

## T-010 [bug] Fail closed on gate errors, settings and merge flags
- status: todo
- version: 0.3.0
- depends: T-009
- how: (1) register.tsx lines ~808-815 and ~874-877: when `git diff` or `gh pr diff` fails (e.g. HTTP 406 on very large PRs), deny instead of skipping the test-change and weakening checks. (2) `parseSettings` (hooks/lib.ts ~333-365): non-array `buildCmd`/`e2eCmd`/`testCmd`, `testCmd` containing empty strings, `e2eFor` with values outside the four types, non-integer or non-positive `testTimeoutMs`, and numeric `stopAfterVersion` each return a problem instead of silently becoming a default or `[]`. (3) Merge flags (~576-577): `--admin=true` and `--auto=true` set `hasAdmin`/`hasAuto` (compare `x.split('=')[0]`); deny `-Ro/r` (attached `-R`) and any `GH_REPO`/`GH_HOST` env assignment on `gh` commands.
- accept: `parseSettings` with `buildCmd:"npm run build"` reports a problem; same for string `e2eCmd`, `e2eFor:["Feature"]`, `testCmd:[""]`, `testTimeoutMs:0.5`, `stopAfterVersion:0.10`. `classifyBash('gh pr merge 5 --admin=true')` sets `hasAdmin`; `--auto=true` sets `hasAuto`; `gh pr merge 5 -Ro/r` and `GH_REPO=o/r gh pr merge 5` are denied. A failing diff command in the PR-create and merge guards produces a deny.
- tests: Unit tests per accept bullet; hook tests with a mocked failing `git diff`/`gh pr diff` asserting deny.
