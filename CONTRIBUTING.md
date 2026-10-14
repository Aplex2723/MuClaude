# Contributing

Thanks for helping make MuClaude better.

## Setup

```bash
cd desktop
npm install
npm start        # run the app
npm test         # core logic tests (no Claude install needed)
npm run selfcheck
```

## Guidelines

- Keep changes focused; one topic per pull request.
- Match the surrounding code style. The UI is plain DOM with no framework.
- Run `npm test` before opening a PR. Mention how you tested macOS or Windows behavior.
- The renderer is sandboxed: new capabilities go through `preload.js` and a validated IPC handler in `main.js`.

## Reporting bugs

Use the bug template and include your OS version, Claude Desktop version and the log shown in MuClaude's Apply screen.

## Releasing

Releases are continuous delivery from a tag, and installed apps update themselves from them.

1. Set `version` in `desktop/package.json` (for example `2.6.0`) and merge to `main`.
2. Push the matching tag: `git tag v2.6.0 && git push origin v2.6.0`.
3. The Release workflow builds, signs and notarizes macOS, builds Windows, and publishes the release with
   `latest-mac.yml` / `latest.yml`, the `.zip` and the `.blockmap` files. Those are what installed apps read.

### The `v` tag rules

- The workflow only runs for tags that start with `v` (`v*`). A tag without the prefix, such as `2.6.0`, does nothing.
- The tag must be exactly `v` + the `version` in `desktop/package.json`. If they differ, the build fails
  at its first step. The update feed carries `package.json`'s version, so a mismatched tag would publish a
  release that installed apps see as "not newer", and nobody would be offered it.
- Versions must increase (semver). Apps never downgrade, so a lower version than the latest is ignored.
- A tag containing `-` (for example `v2.6.0-beta.1`) is published as a prerelease and is **not** offered to users.
- Do not re-point or reuse a published tag. Installed apps may have already read its `latest*.yml`; ship a new
  version instead (a broken release is superseded by `v2.6.1`, not edited).
- Also fails if `latest-mac.yml` / `latest.yml` is not generated, so a release cannot go out without its update feed.
