# Security policy

code-factory runs an autonomous loop that lets a model edit code, run commands,
open pull requests and merge them in your repository. Treat it with the care you
would give a new contributor with push access to a branch.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's
private reporting instead: open the repository's **Security** tab and choose
**Report a vulnerability**
(<https://github.com/sean85120/code-factory/security/advisories/new>).
If that option is not available, open an issue that says only that you have a
security report and asks for a private way to send it. Put no details in the
issue.

Include what you found, the steps or input that trigger it, the version
(`.claude-plugin/plugin.json`) and the Claude Code version. You can expect an
acknowledgement within a week. Fixes for confirmed problems are released as soon
as they are ready, and you will be credited unless you prefer not to be.

## What counts

The guards are best-effort hooks, **not a sandbox**. The documented limits are
listed under "Guards" in [`CLAUDE.md`](CLAUDE.md) (for example, the Bash guard
does not see through `bash -c`, `eval` or absolute-path `git`/`gh`, and the spend
ledger lives outside the repository). A report that only restates one of those
accepted limits is a feature request, not a vulnerability.

In scope, for example:

- a way for text from a repository, an issue, a pull request, a commit message or
  CI output to run a command, forge a line in the factory's replies, or reach the
  terminal as an escape sequence;
- a way for the model to change the approved decisions, the state or lock files,
  or to merge or push to the base branch while the loop is live, using only the
  tools the guards claim to cover;
- a shell-injection path through any value the factory prints into a command
  (branch names, search text, issue numbers);
- a failure of the approval hash, the review gate or the merge gate that lets
  unreviewed or red code merge.

## Using it safely

- Turn on branch protection for the base branch (required reviews, required
  status checks, no force pushes, applies to admins). Set
  `requireBranchProtection` in `.factory/settings.json` to refuse to run without
  it.
- Set `budgetUsd` so a run stops at a spend you chose.
- Read what merges, as you would for any contributor. The independent review is
  another model, not a person.
- Open issues and pull requests are written by other people. The factory treats
  them as reports, never as instructions, but do not point it at a repository
  where you would not trust the people who can open issues.
