# MuClaude

Run **several Claude Desktop accounts side by side** on one computer (macOS and Windows).
Each instance has its own sign-in, chats and settings, plus its own **colored icon and badge**,
so you always open the right one.

![MuClaude editor](docs/screenshots/v2-editor.png)

- **Double-click** an instance in the list to open it.
- **Single-click** it to choose between **Open** and **Edit**.
- Light and dark mode, Anthropic-style ivory and coral design.

## Credits

MuClaude is built on the ideas and file layout of
**[claude-multi-instance](https://github.com/Dipson-bot/claude-multi-instance)** by Dipson-bot, which
created the original Python/Tkinter tool. Thanks for the groundwork. MuClaude keeps the same instance
manifest, so existing instances keep working, and adds a **much better UI**: a modern Electron app
with a real instance list, live icon preview, dark mode, safer handling of edge cases and a packaged
macOS app. The original code is kept in `app/` and its README in `docs/ORIGINAL-README.md`.

> [!IMPORTANT]
> Independent community tool, **not affiliated with, endorsed by, or supported by Anthropic**.
> On Windows, extra instances run from a modified copy of Claude Desktop (your original is never
> changed). Use at your own risk and check your organization's policies first.

## Get started

```bash
cd desktop
npm install
npm start               # run from source
npm run install:mac     # build MuClaude.app and copy it into /Applications
```

The app is ad-hoc signed, not notarized: the first time, right-click it and choose **Open**.
Full details (how it works, security model, edge cases, Windows build) are in
[desktop/README.md](desktop/README.md).
