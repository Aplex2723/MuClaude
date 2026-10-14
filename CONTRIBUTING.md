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

Releases are continuous delivery: merging to `main` publishes a new version when `desktop/package.json`
carries a version that has no release yet, and installed apps update themselves from it.

1. In your PR, bump `version` in `desktop/package.json` (for example `2.6.0`).
2. Squash-merge the PR into `main`. The Release workflow creates the tag `v2.6.0` at the merged commit,
   builds, signs and notarizes macOS, builds Windows, and publishes the release with `latest-mac.yml` /
   `latest.yml`, the `.zip` and the `.blockmap` files. Those are what installed apps read.
3. A merge that does not change `version` (docs, CI, a fix you are not shipping yet) releases nothing.

You never create the tag yourself. Pushing a `v*` tag by hand still works as a manual way to release.

### The `v` tag rules

- The tag is always `v` + the `version` in `desktop/package.json`; the workflow derives it, so a merge cannot
  produce a mismatch. A hand-pushed `v*` tag must match, or the run fails at its first step. The update feed
  carries `package.json`'s version, so a mismatched tag would publish a release that installed apps see as
  "not newer", and nobody would be offered it.
- A tag without the prefix, such as `2.6.0`, does nothing.
- Versions must increase (semver). Apps never downgrade, so a lower version than the latest is ignored.
- A version containing `-` (for example `2.6.0-beta.1`) is published as a prerelease and is **not** offered to users.
- Do not re-point or reuse a published tag. Installed apps may have already read its `latest*.yml`; ship a new
  version instead (a broken release is superseded by `2.6.1`, not edited).
- A release also fails if `latest-mac.yml` / `latest.yml` is not generated, so nothing ships without its update feed.
