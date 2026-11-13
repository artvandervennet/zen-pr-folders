# PR Live Folders

[![CI](https://github.com/artvandervennet/zen-pr-folders/actions/workflows/ci.yml/badge.svg)](https://github.com/artvandervennet/zen-pr-folders/actions/workflows/ci.yml)
[![License: MPL 2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](LICENSE)

An open-source [Sine](https://github.com/CosmoCreeper/Sine) mod for [Zen Browser](https://zen-browser.app). It adds pull request folders that you steer with GitHub search queries, and groups stacked pull requests by [GitHub Stacks](https://docs.github.com/en/pull-requests/get-started/stacked-prs-quickstart). It works with your github.com login; a token is optional.

## Install

You need Zen Browser with [Sine](https://github.com/CosmoCreeper/Sine#installation) installed.

1. Open `about:config` and set `sine.allow-unsafe-js` to `true`. Sine only runs JavaScript from mods outside its own store with this on. Read [what the mod has access to](SECURITY.md#what-the-mod-has-access-to) before you turn it on.
2. Open Zen's settings, go to the Sine section and install a mod from GitHub with:

   ```text
   artvandervennet/zen-pr-folders
   ```

3. Restart Zen.
4. Sign in to github.com in Zen, in the space where you want the folder.
5. Right-click the tab sidebar, choose **New PR live folder…** and enter a query, for example `is:open involves:@me`.

To remove the mod, remove it in Sine's settings. Your queries and presets stay in `zen-pr-folders.json` in the profile folder until you delete that file.

### Install for development

1. Clone this repository.
2. Link the clone to `<profile>/chrome/sine-mods/zen-pr-folders`. The folder name must be `zen-pr-folders`, because the window script loads the engine from `chrome://sine/content/zen-pr-folders/`.
3. In `<profile>/chrome/sine-mods/mods.json`, add the contents of `theme.json` under the key `zen-pr-folders`, with `"enabled": true` and `"no-updates": true`.
4. Restart Zen after every change. Find the profile folder under `about:profiles`.

## What it does

- A folder has a query in [GitHub's search syntax](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests), such as `is:open org:my-org review-requested:@me -label:wip`.
- Subfolders have their own query, added to the folder's. With subfolders present, the folder itself lists what matches its query and no subfolder.
- Pull requests in a GitHub Stack are grouped, one group per stack, in merge order. A stack group can have its own filter.
- New pull requests and stack groups are added at the top. What is already in the folder keeps its place, unless **Re-sort PR folders by activity on every refresh** is on in the mod's settings. With it on, the most recently updated move to the top. The first fill of a folder is sorted by activity, or in GitHub's order when the query has its own `sort:`.
- A pull request that is merged, closed or stops matching has its tab closed on the next refresh. The tab you are looking at stays, struck through, and closes when you switch to another tab.
- Closing a tab hides that pull request in that folder until it stops matching. **Restore closed pull requests** brings them back.
- Folders refresh every 60 seconds by default, and also when you expand one, when the window regains focus and after the computer wakes.

It is separate from Zen's built-in live folders and does not change them.

## Use

Right-click a PR folder for **Edit query…**, **Add subfolder with query…**, **Refresh now**, **Refresh every** and **Use a GitHub token (optional)…**. Right-click a stack group for **Filter this stack…**. An existing Zen folder can become a PR folder from its right-click menu, and a plain subfolder inside a PR folder can get a query the same way.

### Presets

Set up a folder or subfolder once (name, icon with Zen's **Change icon**, query), then right-click it and choose **Save as preset**. **New PR live folder from preset** in the sidebar menu and **Add subfolder from preset** on a PR folder then create it in one click. **Remove preset** is on the folder's menu.

### Stack names

A stack group is named after its bottom pull request until you rename it, with **Rename stack…** on its right-click menu or with Zen's own **Rename**. The name stays when pull requests are added to or merged from the stack, and goes away with the stack once it no longer matches. Rename it to an empty name to go back to the automatic one.

### Stack icon

Change the icon of one stack group with Zen's **Change icon**, then right-click it and choose **Use this icon for all stacks**. Existing groups change at once and new ones get the same icon.

### Indentation and lines

In the mod's settings in Sine, **Custom indentation inside PR folders** replaces Zen's indentation with an amount per level (none to 20 px) and draws a line under the last tab of each subfolder and stack group. Switch the lines off per folder with **Line under this folder** and **Line under stacks in this folder**. Presets remember both.

## Where the data comes from

Without a token the mod reads github.com with the login of the folder's space, as Zen's built-in live folder does. The search runs on `github.com/pulls?q=…`, and for each stack one pull request page is fetched to find its members, cached for 10 minutes. These are the pages of GitHub's web interface, not a documented API, so a change on GitHub's side can break this. The Browser Console then shows a `[zen-pr-folders] github.com list format` line with the field names it received.

With a token the mod uses GitHub's GraphQL API, which is documented and returns stack membership directly. A fine-grained token needs read access to Pull requests and Metadata. A classic token needs the `repo` scope, authorised for SSO where the organisation requires it. The token is stored in the browser's login store.

## Limits

- Pull requests on github.com only. No issues, no GitHub Enterprise.
- At most 200 pull requests per folder or subfolder.
- GitHub has no search qualifier for stacks, so a stack filter runs a normal search in the stack's repository and keeps the results that are in the stack.
- Tested with Zen 1.24.1b and Sine 2.3.3 on macOS.

## Development

```bash
npm test
```

The `lib/` modules hold the logic that does not need a browser: query composition, the two GitHub clients (session and API), stack grouping and the tab diff. `engine.sys.mjs` is the shared instance that polls and stores state. `window.uc.mjs` runs in each window and moves the tabs. The tests run under Node 20 or later and need no dependencies.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose a change, and [CHANGELOG.md](CHANGELOG.md) for what changed per version.

## License

[Mozilla Public License 2.0](LICENSE), the license of Zen and Firefox. Not affiliated with Zen Browser, Sine or GitHub.
