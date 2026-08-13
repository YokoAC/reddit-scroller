# Reddit Scroller — Design

**Date:** 2026-08-13
**Status:** Approved, ready for implementation planning

## Problem

While gaming full-screen on one monitor, a Reddit feed is open in Firefox on a second
monitor. The feed should scroll on its own at a controllable speed, and it should be
possible to pause, change speed, open the post currently in view, and return to the feed
— all without alt-tabbing, touching the mouse, or leaving the game.

A previous attempt (`C:\Development\rosch43`) drove a *separate* Playwright-launched
Firefox and copied cookies and localStorage out of the real Firefox profile to stay
logged in. That sync layer was the bulk of the complexity and existed only because the
automated browser was not the user's browser. This design removes that problem by running
inside the browser the user already uses.

## Goals

- Smooth auto-scrolling of the Reddit feed at an adjustable speed.
- Global hotkeys that work while a full-screen game holds focus.
- An on-screen readout of state, readable at a glance from the other monitor.
- Open the post currently in view and return to the feed, keeping feed position.
- Runs in the user's real, already-logged-in Firefox.

## Non-goals

- old.reddit.com support. New Reddit (`www.reddit.com`) only.
- Voting, saving, commenting, or any other Reddit interaction.
- Any browser other than Firefox.
- Content extraction, archiving, or summarisation.

## Architecture

Two processes communicating over loopback HTTP:

```
┌─ Firefox (monitor 2) ────────┐        ┌─ Python daemon (background) ─┐
│  https://www.reddit.com      │        │                              │
│  ├ userscript (Violentmonkey)│ ◀─────▶│  HTTP server 127.0.0.1:8765  │
│  │  ├ scroll engine          │  long- │  ├ GET  /events (long-poll)  │
│  │  ├ post selection         │  poll  │  ├ POST /state               │
│  │  └ HUD overlay            │        │  └ GET  /health              │
│  └──────────────────────────-┘        │  global numpad hotkey hook   │
└──────────────────────────────┘        └──────────────────────────────┘
```

The daemon owns the keyboard. The userscript owns everything that happens on the page.
Commands flow down, state flows up.

### Why a userscript rather than an extension

Firefox refuses to permanently install unsigned extensions. A userscript under
Violentmonkey (installed once from addons.mozilla.org) persists across restarts, needs no
AMO account or signing step, and Violentmonkey can track the local `dist` file so a
rebuild is picked up with one click.

### Why long-polling rather than a WebSocket

A `ws://127.0.0.1:8765` connection opened from an `https://www.reddit.com` page is
subject to Firefox's mixed-content blocker, and userscript managers do not proxy
WebSocket traffic through their privileged context. `GM_xmlhttpRequest` *does* run in
Violentmonkey's background context, is not mixed-content blocked, and is not subject to
CORS. A long-poll — server holds the request up to 25 s, client re-polls immediately on
return — delivers commands with latency indistinguishable from a socket for this use
case.

**This is assumption #1 and must be verified first.** Before any other work, a throwaway
spike confirms that a `GM_xmlhttpRequest` GET from `https://www.reddit.com` to
`http://127.0.0.1:8765/health` succeeds under Violentmonkey in the user's Firefox. The
userscript must declare `// @connect 127.0.0.1` and `// @connect localhost`.

If the spike fails, the fallback is to serve the daemon over HTTPS with a self-signed
certificate trusted in the Firefox profile. That fallback is not built unless needed.

## Components

### Daemon — `src/reddit_scroller/`

| Module | Responsibility |
|---|---|
| `config.py` | Load and validate `config.json`; resolve key names to `(scan_code, is_keypad)` pairs; supply defaults. |
| `bus.py` | Append-only event log with monotonic sequence numbers; `append(command)`, `since(cursor)`, and an async wait primitive for long-poll. Holds the latest browser-reported state. |
| `hotkeys.py` | Install a single global `keyboard.on_press` hook; dispatch on `(scan_code, is_keypad)` to a command name; push to the bus. Nothing is suppressed. |
| `server.py` | aiohttp app exposing `/events`, `/state`, `/health`. |
| `__main__.py` | Wire the pieces together, print a live status line, handle shutdown. |

Each module is independently testable: `bus` and `config` are pure, `hotkeys` takes the
bus as a dependency and can be driven with synthetic key events, and `server` is
exercised through aiohttp's test client with a fake bus.

### Userscript — `userscript/src/`

| Module | Responsibility |
|---|---|
| `transport.js` | Long-poll loop over `GM_xmlhttpRequest`, cursor tracking, retry backoff, state POSTing. Emits commands; knows nothing about Reddit. |
| `scroll.js` | rAF loop, px/s speed model, start/stop/adjust, sub-pixel accumulation. Knows nothing about posts. |
| `selection.js` | Read `<shreddit-post>` elements, rank against the focus line, expose selected post and next/prev movement. Pure ranking function separated from DOM reads. |
| `hud.js` | Render the overlay from a plain state object. No logic beyond formatting. |
| `main.js` | Command reducer: maps command names to actions given the current mode; owns persisted state. |

Built to `userscript/dist/reddit-scroller.user.js` with esbuild (`npm run build`).
Violentmonkey is pointed at the `dist` file.

## Behaviour

### Commands and default bindings

| Key | Command | In feed | In thread |
|---|---|---|---|
| Numpad `0` | `toggle` | pause / resume scrolling | pause / resume scrolling |
| Numpad `Enter` | `open` | open selected post | — |
| Numpad `.` | `back` | — | back to feed |
| Numpad `+` | `faster` | +15 px/s | +15 px/s |
| Numpad `-` | `slower` | −15 px/s | −15 px/s |
| Numpad `8` | `prev` | select previous post | scroll up 80% viewport |
| Numpad `2` | `next` | select next post | scroll down 80% viewport |

Bindings are matched by **scan code plus the `is_keypad` flag**, never by key name. This
distinguishes Numpad-8 from Up-arrow regardless of Num Lock state. Relevant Windows set-1
scan codes: `0`=82, `2`=80, `8`=72, `.`=83, `+`=78, `-`=74, `Enter`=28 (keypad).

No key is suppressed, so the focused game continues to receive every keystroke.

### Scrolling

A `requestAnimationFrame` loop calling `window.scrollBy(0, speed * dt)` where `speed` is
in **pixels per second** and `dt` is the frame delta in seconds. Speed is therefore
independent of monitor refresh rate. Fractional remainders accumulate across frames so
low speeds stay smooth.

- Default: 90 px/s
- Range: 15–600 px/s, clamped
- Step: 15 px/s

### Selection

Posts are `<shreddit-post>` custom elements carrying `permalink`, `post-title`,
`subreddit-prefixed-name` and `score` as attributes — readable without touching shadow
DOM. The selected post is the one whose top edge is nearest a **focus line at 25% of
viewport height**, among posts intersecting the viewport. It is outlined in the page via
an injected CSS class on the host element and named in the HUD. Selection recomputes on
scroll, throttled to one rAF.

`next` / `prev` move selection one post in document order and scroll that post's top edge
to the focus line.

### Navigation

- `open` sets `location.href` to the selected post's permalink. Full navigation, not an
  SPA route — more reliable and gives real history.
- `back` calls `history.back()`, which restores the feed's scroll position.
- Mode is derived from the URL: a `/comments/` path means thread, otherwise feed.

Scroll running-state and speed are persisted through `GM_setValue` and restored on load,
so "open a thread and keep scrolling" works across the navigation.

### HUD

Fixed bottom-right panel, `z-index: 2147483647`, ~18px text so it is legible from a
glance at the other monitor:

```
  ▶ SCROLLING            ● daemon
  ─────────────────────────────
  90 px/s   ▓▓▓▓▓░░░░░░░
  FEED
  r/buildapc
  "Is 64GB overkill in 2026?"
```

Shows: run state (colour-coded), speed with a bar, mode, selected post's subreddit and
title (clamped to two lines), a daemon connectivity dot, and a brief flash of the last
command received.

When Firefox itself has focus, a plain `keydown` listener maps the same keys to the same
commands. This costs almost nothing and makes manual testing possible without the daemon.

## Error handling

| Condition | Behaviour |
|---|---|
| Daemon not running or stopped | HUD dot turns red; transport retries with backoff 1 s → 5 s cap; page-level scrolling and in-page keys keep working. |
| No `<shreddit-post>` elements found | HUD shows "no posts detected"; scrolling still works; open/next/prev are no-ops. |
| Port 8765 already in use | Daemon exits immediately with a clear message naming the port. |
| Multiple Reddit tabs open | Every tab polls the same cursor-based log and receives every command; tabs where `document.hidden` is true ignore commands. |
| Game runs elevated | Windows will not deliver hooked keys to a non-elevated process. README documents running the daemon elevated in that case. |
| Malformed `config.json` | Daemon refuses to start and names the offending field. |

## Testing

**Python (pytest):**
- `config`: defaults, key-name resolution, rejection of unknown keys and out-of-range speeds.
- `bus`: sequence monotonicity, `since(cursor)` returns exactly the unseen tail, waiters
  wake on append, multiple independent cursors.
- `hotkeys`: synthetic key events with varying `scan_code` / `is_keypad` map to the right
  commands and only to those; unbound keys produce nothing.
- `server`: `/events` returns queued events and honours the cursor, holds and times out
  cleanly when empty, `/state` round-trips, `/health` responds.

**JavaScript (vitest):**
- `selection`: ranking given synthetic rects — nearest to focus line wins, empty list is
  handled, next/prev clamp at the ends.
- `scroll`: speed clamping at both bounds, distance accumulates correctly over frames,
  stop halts the loop.
- `main`: command reducer produces the right action for each (command, mode) pair.
- `hud`: renders expected text from a given state object.
- A jsdom fixture feed of synthetic `<shreddit-post>` elements exercises the DOM-reading
  half of `selection`.

**Manual:** the spike above, then an end-to-end pass with a real feed and a real game in
the foreground.

## Repository layout

```
reddit_scroller/
  pyproject.toml                    uv, Python 3.13
  config.json                       gitignored
  config.example.json
  README.md
  src/reddit_scroller/              config.py bus.py hotkeys.py server.py __main__.py
  userscript/
    package.json                    esbuild + vitest
    src/                            transport.js scroll.js selection.js hud.js main.js
    dist/reddit-scroller.user.js    committed; Violentmonkey tracks this
  tests/
  docs/superpowers/specs/
```

## Configuration — `config.json`

| Field | Default | Meaning |
|---|---|---|
| `port` | `8765` | Loopback port for the daemon. |
| `default_speed` | `90` | Starting scroll speed, px/s. |
| `speed_step` | `15` | Increment per `faster` / `slower`. |
| `speed_min` / `speed_max` | `15` / `600` | Clamp bounds. |
| `focus_line` | `0.25` | Selection focus line, fraction of viewport height. |
| `bindings` | see table above | Command name → key name. |

## Open risks

1. **`GM_xmlhttpRequest` to loopback may be blocked.** Highest-impact unknown; retired by
   the spike before anything else is written. Fallback is a self-signed HTTPS daemon.
2. **Reddit may change or drop `<shreddit-post>`.** Contained to `selection.js`, and the
   failure mode is graceful (scrolling continues, HUD reports it).
3. **`keyboard` hook reliability with full-screen exclusive games.** Some games capture
   input in ways that interfere. Mitigation is documented (borderless windowed mode,
   elevated daemon); if it proves fatal, the binding scheme is configurable enough to move
   to keys the game does not touch.
