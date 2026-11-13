# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Rename a stack group with **Rename stack…** or Zen's own **Rename**. The name survives refreshes and restarts.

## [0.1.0] - 2026-11-11

### Added

- PR live folders driven by GitHub search queries, refreshed every 60 seconds by default.
- Subfolders with their own query, added to the folder's query.
- Automatic groups per GitHub Stack, in merge order, each with an optional filter.
- Reading through the github.com login of the folder's space, with an optional token for the GraphQL API.
- Pull requests that stop matching leave on the next refresh, or stay struck through while their tab is open.
- Presets that create a folder or subfolder with its name, icon and query in one click.
- One icon for all stack groups.
- Custom indentation per level, with an optional line under each subfolder and stack group.

[Unreleased]: https://github.com/artvandervennet/zen-pr-folders/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/artvandervennet/zen-pr-folders/releases/tag/v0.1.0
