# REVIEW.md

Rules for the independent reviewer of a code-factory change. Read CLAUDE.md first: it holds the architecture and the trust model.

## What failure means here

A finding is Important only when it is one of these four failures, reachable on real input:

1. **A guard lets a forbidden action through.** A commit, push or merge on the base branch; a force push; a PR opened or merged without a clean review for the current HEAD or green CI; a write to the factory's state or lock files; a model-reachable path to a command only the person may run (for example `publishDesign` from anything but the typed `/factory-approve`).
2. **The loop overrides the person.** A pause, stop, approve or start from the person is ignored or overwritten by a stale `advance()`; a lock held by another session is taken over; a prompt is sent after a stop.
3. **Spend or state is silently wrong.** The budget is not enforced or fails open; dollars are charged to the wrong item or run; events, approvals or `state.json` content are lost or overwritten with defaults.
4. **Repo or model text reaches the terminal raw.** Escape sequences, C1 or bidi controls, or an unquoted branch name printed without `cleanText`, `safeLines` or `deny()`; a new string that carries a title, reason or other model text where the code promises fixed words only.

Anything else (style, naming, refactors, wording) is a Nit or Low.

## Skip

- `docs/img/*.png` (generated screenshots)
- `opencode/package-lock.json`

## Sensitive paths

Run the separate security pass when the diff touches:

- the guards and the approve/publish path in `hooks/register.tsx`
- `core/factory.ts`
- `codex/hook.ts`
- `.github/workflows/`

## Nits

At most 3 per review. Pre-existing findings are listed once and never counted.

## How to run the checks

These are the commands CI runs (`.github/workflows/ci.yml`):

```
scripts/check-version.sh
claude plugin validate .
claude plugin test .
node --experimental-strip-types --test core/*.spec.ts codex/*.spec.ts opencode/*.spec.ts
npm ci --prefix opencode --no-audit --no-fund && npx --prefix opencode tsc -p opencode
```

Locally also run `tsc -p .` (it needs the types a live Claude Code session generates, so CI skips it).
