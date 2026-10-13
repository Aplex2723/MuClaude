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
npm run dev             # build native sign-in helper + run from source; provides `muclaude-dev` until you stop it
npm test                # Desktop + Code tests in temporary homes
npm run test:google-native # callback delivery between real disposable macOS processes
npm run test:google-ui   # per-instance sign-in UI + IPC checks in a temporary home
npm run install:cli     # standalone muclaude command in ~/.local/bin (macOS)
npm run selfcheck       # launches the real window and confirms the UI rendered
npm run dist:mac        # -> dist/mac-arm64/MuClaude.app and dist/MuClaude-<ver>-arm64.dmg
npm run install:mac     # build + copy into /Applications (add -- --no-build to reuse the last build)
npm run dist:win        # run on Windows -> portable exe + installer
npm run icons           # regenerate build/icon.* from ../assets/app-icon.png
```

**Using it as a normal Mac app:** run `npm run install:mac`, or open the `.dmg` and drag
*MuClaude* to *Applications*. After that, launch it from Spotlight or Launchpad like any other
app; no terminal or npm needed. It is ad-hoc signed, not notarized, so the first time right-click it
and choose **Open**. This is an Apple Silicon build (an Intel build is untested).

## How it works

Claude Code profile usage and the exact sharing boundary are documented in the
[main README](../README.md#claude-code-profiles-macos). The plain Node CLI lives in
`src/code/`; packaged apps include the same files outside the ASAR at
`Contents/Resources/code-cli`, so installing the command from the window does not
need Electron to run it. Node.js 18+ and Claude Code must be on the terminal's PATH.
The window's **Uninstall…** button and `muclaude uninstall` remove the command and, if asked,
the profile data (`src/code/uninstall.js`); see the main README.
Code profiles do not use Desktop's `instances.json` or its data directories.

On macOS, select a Desktop instance and use **Sign in with Google** before clicking
**Continue with Google** in Claude. A native helper temporarily receives browser
returns and sends the original callback to the selected running PID. It checks the
process's executable and exact profile arguments again before delivery, keeps
Claude's nonce validation, and never saves the callback URL. Click **Done / Cancel
routing** when finished. The previous `claude://` handler is restored on return,
cancel, timeout, or quitting; unrelated Claude links keep their previous handler.
The helper is compiled by `npm run dev`, `npm start`, and `npm run dist:mac`; packaged
apps include the executable and do not need Swift or Node for this feature.

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
