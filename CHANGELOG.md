# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (while the version is below 1.0, a
minor version may change behavior).

## [Unreleased]

## [0.4.6] - 2026-11-22

### Changed

- Vox's terminal face is bigger and more detailed: 30 by 12 cells (60 by 24 half-block
  pixels) instead of 22 by 8, still only space, upper-half and lower-half block glyphs and
  colors derived from the palette tone. The head is a shaded rounded shape with a rim, the
  antenna has a glow, the eyes have a sclera with a pupil and a highlight dot, eyelids
  close from the top (idle is half-lidded, a blink or hold closes them), brows are two
  pixels thick (raised, angry, none), the mouth has four shapes (smile, flat, frown, grin)
  and the cheeks blush. The pupil takes the gaze in half-pixel steps by blending its edge
  into the sclera; the idle drift is now half a pixel so a pointer gaze stays distinct. The
  glint scan, sparkles, `z`, coin, shake and lift are redrawn for the bigger grid. The
  pane still lays out at 70 columns (the speech beside the face has 36 columns of room).
  `poseAt` timing and the single blit per frame are unchanged; `VoxPose` gains a `lid`
  field. The ASCII art and the desktop SVG are unchanged.

## [0.4.5] - 2026-11-22

### Added

- Vox looks at the mouse pointer. Under the hacker look on the terminal surface at 70
  columns or more with motion on, the dashboard pane draws a `Client` (module
  `hooks/vox-client.tsx`, key `vox-gaze`) over the `Raster` face. The plugin API reports a
  pointer only over a `Client` region, so the face reacts while the pointer is over it:
  the pupils move up to two half-pixel columns sideways and one half-pixel row up or down
  toward it (`gazeFrom`, a dead zone near the center, clamped, sub-cell coordinates when
  the terminal reports them). A leave, or no pointer event for 6 seconds
  (`GAZE_TIMEOUT_MS`), clears the gaze and the face goes back to its drift and scan.
  Only the states with open eyes (running, reviewing, idle) look; done, hold, blocked and
  budget ignore the pointer.
- `poseAt` takes an optional gaze and `VoxPose` carries it; `faceCells` moves the eyes by
  it. `faceWords` returns the cell words without the base64 step, for the surface module.
- The module draws only text (space, upper-half and lower-half block glyphs) with colors
  derived from the palette tone, keeps its own pointer state and timer, and carries no
  repo or model text: its props are the state word and the tone.

### Notes

- The `Raster` face stays in the pane under the `Client`, so a `Client` that cannot mount
  (the engine leaves it out after a fault) leaves today's blitted face untouched. With
  motion off, the ASCII tier, the classic look, a narrow pane or the desktop surface
  nothing changes.
- The `Client` mount, the overlay and the pointer behaviour are unverified live; the
  tests drive the module through the test harness.

## [0.4.4] - 2026-11-22

### Added

- A plain "now" line on every surface of the Claude Code plugin. While the loop runs the
  band (under its header, and as the only extra line of the compact band), the dashboard
  pane (at the top, above the controls) and the status line say what it is doing:
  `Building T-009, attempt 2/4`, `Reviewing T-009, round 1/3`,
  `PR #12 open: waiting for CI`, `Merging PR #12`. The sentences come from `nowLine` in
  `hooks/lib.ts` and hold only fixed words, item ids and numbers, never a title, reason
  or model text.
- When the loop is not running, `holdLine` names why and the exact next command, in the
  order blocked, budget, awaiting approval, paused by you, all done: `2 items blocked:
  T-009, T-011` with `/factory-retry T-009`, `4 items proposed` with `/factory-approve`,
  `paused by you` with `/factory-start`.
- A live activity line and a stuck warning. While a factory turn runs the dashboard pane
  shows the main loop's last action and how long ago it happened (`Last action: Bash:
  bun test (12s ago)`). After five minutes (`STUCK_MS`, a constant, not a setting, so the
  approval hash is unchanged) without any tool call or turn event, the band (appended to
  the now line when compact), the pane and the status line show `no progress for 5 min:
  wait, or /factory-pause`; the next action clears it. `FactoryView.silentMs` carries the
  quiet time, and is `null` outside a factory turn, where nothing is shown. The warning
  glyph comes from the theme (`⚠` classic, `▲` hacker, `!` ASCII); the action text is the
  already cleaned `recent` entry, so no repo or model text is printed raw. T-004 ships in
  the same 0.4.4 section because 0.4.4 was not tagged or released yet.

### Changed

- The raw pause reason `nothing left to do` no longer shows in the band header, the pane,
  the pane's next-step hint or the status line; the cause and command from `holdLine`
  replace it. The budget reason and your own pause keep their wording. Classic keeps every
  other string it had. Tests that pinned the old header were left as they were (none
  pinned it); new tests pin the new sentences in the classic, hacker and ASCII looks.

## [0.4.3] - 2026-11-22

### Changed

- The design interview no longer tells the model to check out the base branch, commit
  and push the design files (or open a PR when the base is protected). It reads the
  design back and sends the person to `/factory-approve`, which has published the
  design files to the base branch itself since 0.4.1, and then `/factory-start`. The
  printed git steps stay as the fallback `/factory-approve` shows when publishing
  fails.

## [0.4.2] - 2026-11-22

### Fixed

- The loop could not see a merged PR when the repository had been renamed on
  GitHub and `origin` still pointed at the old name: the check used
  `gh pr list --search head:<branch>`, and GitHub search does not follow renames, so
  it returned nothing and the item was nudged until it blocked. The check now asks
  for `--head <branch>`, which resolves through the redirect (Claude Code, OpenCode
  and Codex).

## [0.4.1] - 2026-11-22

### Changed

- In Claude Code, `/factory-approve` now publishes the design files itself. When
  `.factory/todo.md`, `design.md` or `settings.json` is missing from or differs on
  `origin/<base>` (new proposed items from a triage or next-phase interview, for
  example) and nothing else blocks approval, it commits them onto `origin/<base>`
  with git plumbing and a fast-forward push: no branch switch, no change to your
  working tree or staged files. The model still never commits or pushes. If the
  push is refused (protected base, no git identity), approve says why and prints
  the same manual steps as before. The interview prompts no longer hand the person
  git commands; they point to `/factory-approve`.

## [0.4.0] - 2026-11-21

### Changed

- The hacker look, with the Vox mascot, is now the default. A person who never ran
  `/factory-theme` gets it; `/factory-theme classic` switches back and is kept. A
  saved `classic` choice is unchanged. The README shows the hacker look first and
  explains when the mascot is drawn (pane width, UTF-8, color).

## [0.3.2] - 2026-11-20

### Fixed

- An item that is already done no longer shows as blocked when a stale note is left in
  `.factory/blocked/` (for example after a blocked item was merged by hand and
  approved as done). The band, status and counts treat it as done, and
  `/factory-retry <ID>` on it removes the stale note instead of only refusing.

## [0.3.1] - 2026-11-20

### Fixed

- A long build or test gate no longer burns an item's attempts. When the model ends a
  turn while its gate is still running, the loop used to re-prompt it every few
  minutes and count each prompt as a failed attempt, so four attempts blocked the
  item before anything could merge. After the first retry prompt, the next one now
  waits one gate length (`testTimeoutMs` for each of the test, build and e2e
  commands that are set, at least five minutes) unless the item shows progress
  (commit, PR, CI result, review) in between.

## [0.3.0] - 2026-11-19

### Fixed

- Installed copies of the plugin never updated, because the manifest version stayed at
  `0.2.0` through every merge and Claude Code only updates a plugin when its
  version changes. The manifests now carry `0.3.0`, and CI fails when the
  manifests and the changelog disagree about the version. Bump all three to
  release.

### Changed

- A pull request whose diff holds only prose (Markdown, reStructuredText, AsciiDoc,
  license files, images under `docs/`) no longer needs test changes. `.txt`
  files do not count, and the changed-file list is read without rename
  detection.

### Added

- OpenCode and Codex support. `core/factory.ts` ports the loop, the commands
  (design, approve, start, stop, pause, status, log, skip, retry, doctor) and
  every commit/push/PR/merge gate to a small host interface, on top of the same
  `hooks/lib.ts` and `.factory/` files. `opencode/` is an OpenCode 2.x server
  plugin (`/factory-*` commands, gates in `tool.execute.before`, the loop in
  the session idle hook). `codex/` holds one hook script for Codex
  (`$factory-*` commands through `UserPromptSubmit`, gates in `PreToolUse`,
  the loop through `Stop` continuations), and the repository is a Codex
  marketplace (`codex plugin marketplace add sean85120/code-factory`). The
  band, dashboard, dollar ledger, issue watcher and the triage and next-phase
  interviews stay Claude Code only. A plan with `budgetUsd` set is refused on
  these hosts instead of being run without a budget.
- The state-file guard also counts `apply_patch`/`applypatch` as commands that
  write files, so a patch to `.factory/state.json` run through the shell is
  refused like `sed -i`.
- `/factory-exit` leaves factory mode: it stops the loop if it is running, closes
  the dashboard, clears the status line, hides the band, and drops an open
  interview's instructions and guards. A factory turn that is still running keeps
  its guards until it ends. `/factory-start`, `/factory-design`, `/factory-approve`,
  `/factory-roadmap`, `/factory-triage`, `/factory-dashboard` or a new session
  bring it back. It writes nothing when the factory was not running.
- The issue watcher (setting `watchIssues`, off by default, `/factory-watch`).
  While the loop is idle it reads the open issues every ten minutes through
  one GraphQL call and applies `issueGate`. For the first issue that needs a
  design it runs one turn with no shell: the factory puts the issue, its comments
  (fenced as untrusted data), the repo notes and the list of tracked files in the
  prompt, and the turn may only use `Read` on those exact files. Symlinks,
  submodules and secret-looking names are never listed, and every other tool is
  denied. The factory posts the turn's final answer as the comment itself, and
  remembers the issue per repo so a new session does not post a second design.
  Turning it on changes the approval hash, so it needs a `/factory-approve`.
- Building from a label (setting `buildFromLabels`, off by default, needs
  `watchIssues`). When someone with write access adds `factory:go` to an issue
  whose design comment still matches what they approved, the factory adds the
  design's `## Item` section to `todo.md` as an item linked to the issue,
  records the approval hash and starts the loop; the pull request closes the
  issue. An edit to the issue, its title or the design comment, or a label from
  someone without write access, removes the label and builds nothing. A blocked
  item tells the issue once, removes the label and waits for a person.
  The factory's own account (the one `gh` is logged in as) can never approve,
  because the model can reach it, so approve from a different account. The item
  the writer approves is shown as raw text in a code block the factory builds,
  so a hidden link or a fenced example cannot change what gets built. The block
  comes first in the comment and item-like headings in the free text are removed,
  so the way GitHub reads fences cannot hide or imitate it.
- An "all done" screen: when every item is merged, the band, the pane, the
  status line and the finish toast say so and ask whether to continue the design
  (`[➜ design next phase]`, `[⚑ triage issues]`) or stop (`[■ stop here]`, which
  collapses the prompt to one line until the done count changes).
- The pure decision logic for label-gated issue handling (`issueGate` in
  `hooks/lib.ts`): who may trigger triage, who may approve with `factory:go`, a
  SHA-256 pin of the approved issue and design text, and when an approval counts
  as stale.
- README screenshots of the band, the dashboard, an expanded agent, the desktop
  pane and Vox's seven states, generated by `scripts/demo-shots.sh` from the
  plugin's own element trees (macOS with Google Chrome, bun and python3).
- The hacker look on the Claude desktop app draws the pane as a dark console
  (a fixed dark fill and the dark palette, whatever your Claude theme is), shows
  Vox as an animated SVG face that honors the OS reduced-motion setting, adds a
  stage pipeline drawing for the current item, and gives plan rows a hover
  highlight. The terminal is unchanged. The drawings hold only fixed words, so
  no repo or model text reaches their markup. Bordered sections are not drawn:
  which `borderStyle` strings the desktop paints is not verified.
- `/factory-theme hacker` recolors the band and pane in a phosphor palette that
  follows your Claude theme (dark, light or 16-color) and honors `NO_COLOR`.
  The choice is stored in your plugin store, outside the repo, so it never
  changes the approval hash. `classic` stays the default.
- The hacker look also changes the shape of the interface: a `❯ factory [RUN]`
  header with `[RUN]`, `[HOLD]`, `[DONE]` and `[FAIL]` badges, `▰▱` bars, `──`
  section rules sized to the pane, and control glyphs that never render
  double-width. `/factory-theme ascii` (or a locale that is not UTF-8, or
  `TERM=dumb`) switches to plain ASCII. State is never shown by color alone.
- The hacker look has a mascot, Vox, a round ASCII face that shows how the loop
  is doing (running, reviewing, done, held, blocked, over budget, idle). The
  pane shows the 9-row face with a short line beside it when it is at least 60
  columns wide; the band and the status line carry a one-line face such as
  `(o_o)`. The speech is fixed words, ids and numbers only.
- Vox is animated on terminals: a half-block pixel face in the pane that blinks,
  looks around while it works, scans while it reviews, hops when the plan is
  done, shakes once when something blocks, sleeps while paused and spins `$`
  eyes at the budget. `/factory-theme motion off` keeps it still. It stays still
  under `NO_COLOR`, the ASCII tier and a 16-color Claude theme.
- `scripts/test-serial.sh` runs the test files one at a time, for a busy machine
  where the parallel run times out.

### Changed

- Pressing an agent in the band or the dashboard pane shows its transcript (task,
  words, tool calls with results and errors), refreshed live, instead of only
  its last five actions.

- The reviewer follows the `review-fix` rules: a Critical/High, Medium and Low
  severity rubric with a failure scenario per finding (Low is declined by
  default, an unproven High counts as Low), the security pass only when the
  change touches auth, privacy, deletion, payment, CI workflows or installers,
  fixes re-reviewed by a fresh agent only above about 50 lines or on those
  paths, a final full pass only above about 150 lines, and a circuit breaker.
- `/factory-design` writes `maxReviewRounds: 3` (three fix cycles). The built-in
  default stays 5, so existing approvals keep their hash.
- The pull request Risk section names a risk tier, the work prompt rebases on
  the base branch before the review, and the hand-back names the tier.

- The reviewer applies those rules itself: a missing `reviewCommand` no longer
  pauses the loop, the reviewer reviews and fixes with fresh verifier agents.

### Added

- MIT license, contributing guide, code of conduct, security policy, issue and
  pull request templates, and a README with requirements, settings reference and
  the trust model.

### Fixed

- Building from a label only trusts a design the factory recorded posting (a
  SHA-256 of the posted body in the plugin store). A design the model posted
  straight through `gh`, or an edited one, is withdrawn instead of built, an item
  hidden in an HTML comment is never read, and `todo.md` is built from the same
  text the integrity check passed.
- Issue design turn: it is bound to its own turn by the factory's headline text,
  not to whichever main turn ends next, and a launch is dropped when a turn
  opened since the poll. A person's or a background turn's answer can no longer
  be posted on an issue. A typed prompt now only voids the post; the read-only
  restriction holds until the design turn ends.
- Issue design comments are posted only when the answer has the two design
  headings. An issue is claimed for 45 minutes before a launch, so two sessions
  do not both design it, and the designed list is re-read before posting. More
  credential file names are kept out of the file list.

## [0.2.0]

### Added

- `/factory-triage [search]`: reads the open GitHub issues with you and turns the
  ones worth doing into proposed items. Items may carry `- issue: #N`, and their
  pull request then closes the issue.
- `/factory`: where you are, the one next step, and the command list. The
  dashboard shows the same journey, with buttons for design, approve, triage and
  the next phase, and a getting-started screen before approval.
- The next-phase interview also offers the open issues.
- Review depth scales with the size of the change, pre-existing bugs are
  reported apart from the counts and filed as proposed items, and each pull
  request carries a `## Review` overview.
- The repository is its own plugin marketplace
  (`/plugin install code-factory --marketplace sean85120/code-factory`).

## [0.1.0]

### Added

- Design-first autonomous build loop: `/factory-design`, `/factory-approve`,
  `/factory-start`, `/factory-pause`, `/factory-stop`, `/factory-skip`,
  `/factory-retry`.
- Guards for commits, pushes, pull request creation and merges; an independent
  review with a security pass; a post-merge check of the base branch.
- Spend ledger and budget (`/factory-costs`), event timeline (`/factory-log`),
  status (`/factory-status`), the dashboard and band, `/factory-doctor`, and the
  next-phase interview (`/factory-roadmap`).

[Unreleased]: https://github.com/sean85120/code-factory/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/sean85120/code-factory/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/sean85120/code-factory/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/sean85120/code-factory/compare/79e9212...v0.3.0
[0.2.0]: https://github.com/sean85120/code-factory/commit/79e9212
