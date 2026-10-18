# Reddit-Scroller

Userscript auto-scrolls Reddit by numpad + HUD; optional Windows Python daemon delivers global hotkeys over `127.0.0.1`.

## Layout

```text
├── src/reddit_scroller/   daemon: keyboard hook, loopback server, config, key table
├── tests/                 daemon tests
│   └── support/           hookless daemon for the JS suites
├── userscript/
│   ├── src/               modules; main.js wires them
│   ├── dist/              built bundle, committed, what users install
│   └── tests/             unit + dom
│       ├── integration/   against the real daemon
│       └── browser/       Playwright, Firefox + Chromium
└── docs/architecture.md   why things are as they are; read before design changes
```

## Check

- Daemon: `uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest`
- Userscript, in `userscript/`: `npm run lint && npm run test:all`

## Rules

- Never start the daemon (`python -m reddit_scroller`) unasked: real global keyboard hook. Tests use fakes or `tests/support/`.
- Server binds `127.0.0.1` only. No CORS, no other host.
- Hook never suppresses (`suppress=False`).
- Userscript change → `npm run build`, commit `dist/`. CI fails on stale bundle.
- Shipped code or header change → raise `version` in `userscript/package.json`. CI fails otherwise.
- Never change `@namespace`: breaks every install.
- Test first. Coverage thresholds fail build.
- Design change → update `docs/architecture.md` first.
