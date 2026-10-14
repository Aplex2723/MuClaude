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
   `latest-mac.yml` / `latest.yml`, the `.zip` and the `.blockmap` files. Those are what installed apps read;
   the workflow fails if they are missing or if the tag does not match `package.json`.

Tags containing `-` (for example `v2.6.0-beta.1`) are published as prereleases and are not offered to users.
