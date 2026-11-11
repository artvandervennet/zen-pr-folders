# Security policy

## Supported versions

Only the latest release gets fixes.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/artvandervennet/zen-pr-folders/security/advisories/new). Please don't open a public issue. You'll get an answer within a week.

## What the mod has access to

The mod runs with the browser's own privileges, as every Sine JavaScript mod does. It:

- reads `github.com` with the cookies of the space a folder is in,
- sends requests to `api.github.com` only when you set a token,
- stores an optional GitHub token in Firefox's login store (encrypted with your primary password if you set one),
- writes `zen-pr-folders.json` in your profile folder, holding queries, presets and folder ids.

It sends nothing anywhere else and has no telemetry.
