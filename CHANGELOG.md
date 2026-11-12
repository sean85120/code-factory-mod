# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (while the version is below 1.0, a
minor version may change behavior).

## [Unreleased]

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
