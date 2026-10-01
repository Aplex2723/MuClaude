# MuClaude (desktop app)

Credits: based on [claude-multi-instance](https://github.com/Dipson-bot/claude-multi-instance) by Dipson-bot; MuClaude adds a much better UI.

A native-feeling Electron app for macOS and Windows that lets you run several
Claude Desktop accounts side by side. It replaces the old Tkinter wizard (still in
`../app`) with a modern interface and no Python requirement.

![Editor](../docs/screenshots/v2-editor.png)

## Run / build

```bash
cd desktop
npm install
npm start               # run from source (development only)
npm test                # core tests (temp HOME + fake Claude.app) + signing configuration tests
npm run selfcheck       # launches the real window and confirms the UI rendered
npm run build:mac:dev   # Apple Development -> dist/development/mac-arm64/MuClaude.app
npm run dist:mac        # Developer ID + notarized app -> dist/distribution/*.dmg (credentials required)
npm run dist:mac:signed # Developer ID -> dist/signed/*.dmg; NOT notarized, testing only
npm run install:mac     # development build + copy into /Applications (-- --no-build to reuse it)
npm run dist:win        # run on Windows -> portable exe + installer
npm run icons           # regenerate build/icon.* from the in-app drawing routine
```

**Using it as a normal Mac app:** run `npm run install:mac`, or open the `.dmg` and drag
*MuClaude* to *Applications*. After that, launch it from Spotlight or Launchpad like any other
app; no terminal or npm needed. Builds now require real Apple signing identities: there is no
ad-hoc fallback. Only `dist:mac` produces a notarized app for public distribution.
This is an Apple Silicon build (an Intel build is untested).

### macOS signing and notarization

Certificates must be installed in the Keychain **with their private keys**:

```bash
security find-identity -v -p codesigning
```

- **Local development:** `Apple Development`. No notarization or App Store provisioning profile.
  `electron-builder` v26 does not select this certificate for non-MAS apps, so a custom
  signing hook uses `@electron/osx-sign`. If several developers' identities exist, select one
  with `MUCLAUDE_DEV_IDENTITY="<certificate SHA-1>" npm run build:mac:dev`.
- **Direct distribution:** `Developer ID Application`, not `Apple Distribution`.
  Both the app and the DMG are signed. The app uses Hardened Runtime and only the
  `com.apple.security.cs.allow-jit` entitlement, including its helpers. Library validation stays enabled.
- **Release:** `dist:mac` requires notarization credentials, notarizes and staples the app
  before creating the signed DMG, then verifies its app ticket and Gatekeeper acceptance.
  The ticket is attached to the app inside the DMG, not to the DMG container itself.
  Missing credentials or failed signing/notarization fail the build instead of producing
  a successful-looking unsigned or unnotarized release.

Recommended: keep notarization credentials in the Keychain. Run this in your own terminal;
`notarytool` prompts for your **app-specific Apple password**, so do not paste it into chat or git:

```bash
xcrun notarytool store-credentials "MuClaude" \
  --apple-id "YOUR_APPLE_ID" \
  --team-id "YOUR_TEAM_ID"

APPLE_KEYCHAIN_PROFILE=MuClaude npm run dist:mac
```

An existing profile works too: set `APPLE_KEYCHAIN_PROFILE` to its name.
Alternatively, electron-builder accepts `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` +
`APPLE_TEAM_ID`, or `APPLE_API_KEY` (path to a `.p8` team key) + `APPLE_API_KEY_ID` +
`APPLE_API_ISSUER`. Never commit credentials or certificate exports.

`npm start` runs the bundled development Electron binary; use `build:mac:dev` to test a
packaged MuClaude signed with your development certificate. `install:mac` installs that
local development app, not a public release.

### Automated draft releases (GitHub Actions)

`.github/workflows/release.yml` runs when a `v*` tag is pushed:

1. Verify the tag equals `v` + the version in `desktop/package.json`.
2. Run `npm ci` and `npm test` on macOS and Windows.
3. Build the signed, notarized Apple Silicon DMG and the Windows executables. macOS uses
   `dist:mac`, including signature, stapled app ticket and Gatekeeper checks; no ad-hoc fallback.
4. Upload the installers as workflow artifacts. A single dependent job refuses to overwrite
   published releases and attaches both platforms to a **draft release**, only if every build
   succeeds. Publishing remains a separate decision.

#### One-time credentials setup

Hosted runners do not have your local Keychain or the `MuClaude` notarytool profile.
In the repository's **Settings → Secrets and variables → Actions**, configure:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64 of an encrypted `.p12` containing **Developer ID Application and its private key** |
| `CSC_KEY_PASSWORD` | Password protecting that `.p12` |
| `APPLE_ID` | Apple account belonging to the Developer ID team |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password generated at `account.apple.com` |
| `APPLE_TEAM_ID` | Team ID of the Developer ID certificate |

Export only the intended Developer ID identity from Keychain Access; an Apple Development
or Apple Distribution certificate is not a substitute. Keep the export outside the repository.
You can upload the secrets with GitHub CLI without putting passwords in shell history:

```bash
base64 -i /path/outside/repo/DeveloperID.p12 | gh secret set CSC_LINK --repo Aplex2723/MuClaude
gh secret set CSC_KEY_PASSWORD --repo Aplex2723/MuClaude
gh secret set APPLE_ID --repo Aplex2723/MuClaude
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo Aplex2723/MuClaude
gh secret set APPLE_TEAM_ID --repo Aplex2723/MuClaude
```

The `gh secret set` commands without piped input prompt for the value. Never paste passwords
into chat, commit certificate exports or print secret values in Actions logs. These credentials
allow GitHub's runners to sign and notarize releases; restrict who can change release workflows.
Missing secrets fail the macOS build with a list of missing **names**, not their values.

#### Trigger a release

Update `desktop/package.json` and `desktop/package-lock.json` for the next version
(for example, `npm version patch --no-git-tag-version` from `desktop/`), commit the change,
and merge it along with the workflow into `main`. From that updated main checkout:

```bash
VERSION=$(node -p "require('./desktop/package.json').version")
git tag -a "v$VERSION" -m "Release $VERSION"
git push origin "v$VERSION"
```

Do not reuse the already-published `v2.0.0` tag. Watch **Actions → Release**;
on success the draft contains the `.dmg` and `.exe` downloads in **Releases**.
Drafts are visible only to users with repository push access, not to the public.
A failed platform prevents creation of a new release; successful build artifacts remain
available in that workflow run for seven days. Before publication, retrying a tag's workflow
can update its draft assets. After publication, use a new version and tag.

Sources: [electron-builder macOS](https://www.electron.build/v26/docs/mac),
[Electron notarization prerequisites](https://github.com/electron/notarize#prerequisites),
[Keychain credentials](https://github.com/electron/notarize#usage-with-keychain-credentials),
[GitHub artifact sharing](https://docs.github.com/en/actions/tutorials/store-and-share-data),
[draft release action](https://github.com/softprops/action-gh-release/tree/v2#customizing),
[GitHub Actions secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions).

## How it works

Same behavior and file layout as the Python version, so existing instances keep working.

- **macOS:** each instance is a tiny `~/Applications/Claude <Name>.app` that runs
  `open -na Claude --args --user-data-dir=<profile>`. Claude is never modified.
- **Windows:** one patched copy of Claude in `~/ClaudeInstances/app` (asar relocation fix,
  launch shim, integrity fuse off), self-tested on a throwaway profile before it is swapped in.
  Shortcuts are created with Electron's native API (no PowerShell string building).

## Security

- Renderer is sandboxed: `contextIsolation`, `sandbox`, no Node, strict CSP, all remote
  requests blocked, no navigation or popups, permissions denied.
- The preload exposes ten explicit functions; every IPC handler checks the sender and validates input.
- No network code. No telemetry.
- Deletion is confined to this tool's own locations, even if `instances.json` is tampered with
  (covered by tests). Profiles are only trashed if they are `Claude-<name>` folders under the data root.
- macOS launcher scripts single-quote every value; tested with `'` in names.
- Packaged build has Electron fuses set: no `RunAsNode`, no `NODE_OPTIONS`, no inspector flags, the app loads
  only from the ASAR, and **ASAR integrity validation is on** (a tampered copy is refused; tested).
  `GrantFileProtocolExtraPrivileges` stays on: turning it off stops `file://` pages loading from the ASAR
  (it would need a custom `app://` protocol).
- `npm audit`: 0 vulnerabilities (Electron 44, electron-builder 26). `allowScripts` in `package.json` approves
  only Electron's own download script and denies `electron-winstaller`.

## Edge cases handled

- Launcher apps are built in a temp folder and swapped in, so a failed rebuild keeps the old launcher.
- Instances succeed or fail independently; the manifest only lists what was really built.
- Unsafe profile folders (non-empty and not a Claude profile: `~`, `~/Documents`...) are refused, in the picker and in the core.
- A corrupt `instances.json` is backed up (`instances.json.corrupt-<time>`) instead of overwritten.
- If Claude is moved or renamed, launchers fall back to finding it by name; discovery also uses Spotlight.
- Bundle ids stay unique for names like `A-B` / `AB` / emoji (existing ids are unchanged).
- Quitting with unapplied changes asks first; quitting mid-apply is blocked.

## Status

- macOS: built, packaged and exercised end to end (`npm test`, UI driver `npm run screenshots`).
- Windows: ported from the audited Python code and unit-tested for the parts that are pure logic
  (asar read/write verified against `@electron/asar`, JS patching, fuse flip). **Not yet run on a real
  Windows PC**: the self-test, shortcuts, Startup folder and Run key need a real-machine check.
- Linux is not supported in this version.
