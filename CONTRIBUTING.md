# Contributing to ScriptHub (Electron)

Thanks for helping. This is the desktop rewrite of ScriptHub; the architecture is described in the [README](README.md)
(`packages/engine` headless logic, `protocol`, `client`, `ui`, and `apps/electron`).

## Setup

```bash
npm install
npm run dev        # Electron with hot reload
npm run typecheck
npm test           # engine tests (need python and bash on PATH for some)
npm run test:ui    # component tests
npm run e2e        # drives the real app; builds first
```

Node 20 or newer. Tests use throwaway data folders and must never touch a real `runtime/` folder; keep it that way
(use `SCRIPTHUB_HOME` or a temp `DataDirs`).

## Pull requests

- Keep changes focused; add or update tests next to the code (`packages/*/test`).
- `npm run typecheck`, `npm test` and `npm run test:ui` must pass. CI runs them on Windows and Linux.
- The engine must stay free of Electron and DOM imports; the UI must not import the engine (use the protocol).
- Keep data formats compatible with the Django app (`runtime/` layout, `.scripthub` files) unless discussed first.
- If you change a sample script, regenerate the sample projects (see the README).

## Reporting bugs

Open an issue with your OS, the app version, and steps to reproduce. For security problems see [SECURITY.md](SECURITY.md).

By contributing you agree that your work is released under the [MIT License](LICENSE).
