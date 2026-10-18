# AGENTS.md

Userscript auto-scrolls Reddit by numpad + HUD; optional Windows Python daemon delivers global hotkeys over `127.0.0.1`.

## Layout

```
src/reddit_scroller/  daemon: keyboard hook, aiohttp loopback server, config, key table
tests/                daemon tests; support/ = hookless daemon for JS suites
userscript/src/       userscript modules; main.js wires them
userscript/dist/      built bundle, committed, what users install
userscript/tests/     unit + dom; integration/ = real daemon; browser/ = Playwright
docs/architecture.md  why things are as they are — read before design changes
```

## Check

```
uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest
cd userscript && npm run lint && npm test && npm run test:integration && npm run test:browser
```

## Rules

- Never run the daemon (`python -m reddit_scroller`): real global keyboard hook. Tests use fakes.
- Server binds `127.0.0.1` only. No CORS, no other host.
- Hook never suppresses (`suppress=False`).
- Userscript change → `npm run build`, commit `dist/`. CI fails on stale bundle.
- Shipped code or header change → raise `version` in `userscript/package.json`. CI fails otherwise.
- Never change `@namespace`: breaks every install.
- Test first. Coverage thresholds fail build.
- Design change → update `docs/architecture.md` first.
- `main` protected: branch + PR.
