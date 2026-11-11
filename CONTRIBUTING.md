# Contributing

Bug reports, ideas and pull requests are welcome. By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Reporting a bug

Open an issue with the bug template. Include your Zen and Sine versions, what you did, and the lines starting with `[zen-pr-folders]` from the Browser Console (Cmd+Shift+J on macOS, Ctrl+Shift+J elsewhere). Remove repository names, titles or anything else you don't want public before posting.

Security problems go through [private vulnerability reporting](SECURITY.md), not public issues.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Install the mod from your checkout as described in the [README](README.md#install-for-development).
3. Make the change. Keep logic that doesn't need a browser in `lib/`, with tests in `test/`.
4. Run the tests:

   ```bash
   npm test
   ```

5. Try the change in Zen. The tests don't cover anything that touches tabs, folders or menus.
6. Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md).
7. Open a pull request against `main` and fill in the template.

`main` is protected: every change goes through a pull request, the tests must pass, and history stays linear (squash or rebase merges).

## Style

- Plain JavaScript modules, no build step and no runtime dependencies.
- Files that run in the browser (`*.sys.mjs`, `*.uc.mjs`) start with the MPL-2.0 header.
- Two-space indentation, double quotes, semicolons. `.editorconfig` covers the basics.
- Comments explain why, not what.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), for example `fix: keep stack lines inside the folder box`.

## License

Contributions are accepted under the [Mozilla Public License 2.0](LICENSE), the same license as Zen and Firefox.
