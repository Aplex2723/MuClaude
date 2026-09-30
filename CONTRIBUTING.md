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
