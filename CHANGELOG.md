# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (while the version is below 1.0, a
minor version may change behavior).

## [Unreleased]

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

[Unreleased]: https://github.com/sean85120/code-factory/compare/79e9212...HEAD
[0.2.0]: https://github.com/sean85120/code-factory/commit/79e9212
