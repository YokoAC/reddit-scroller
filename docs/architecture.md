# Architecture

Why this is built the way it is. The code and its tests are authoritative for
*what* it does; this covers the *why*, and particularly why several obvious
alternatives were rejected.

## Two processes

```
┌─ Firefox (monitor 2) ────────┐        ┌─ Python daemon ──────────────┐
│  https://www.reddit.com      │        │                              │
│  userscript (Violentmonkey)  │ ◀─────▶│  HTTP server 127.0.0.1:8765  │
│   scroll engine              │  long- │   GET  /health               │
│   post selection             │  poll  │   GET  /events               │
│   HUD                        │        │   GET/POST /state            │
└──────────────────────────────┘        │  global keyboard hook        │
                                        └──────────────────────────────┘
```

The daemon owns the keyboard. The userscript owns everything on the page.
Commands flow down, state flows up.

## The decisions that matter

### A userscript in your own Firefox, not an automated browser

The obvious approach — Playwright or similar driving its own browser — forces
you to copy cookies and localStorage out of the real Firefox profile just to
stay logged in. That sync layer is most of the complexity, and it exists only
because the automated browser is not the browser you are already signed in to.
Running inside the real one removes the problem rather than solving it.

The cost is that Firefox will not permanently install an unsigned extension,
hence a userscript under Violentmonkey rather than a packaged add-on.

### Long polling, not a WebSocket

`ws://127.0.0.1` from an `https://www.reddit.com` page is blocked as mixed
content, and userscript managers do not proxy WebSocket traffic through their
privileged context. `GM_xmlhttpRequest` does run in that context, so it is
neither mixed-content blocked nor CORS-restricted.

This was verified against a real daemon in Firefox before any other code was
written: a `GM_xmlhttpRequest` GET from reddit.com to `http://127.0.0.1:8765`
returns 200, and the server logs no `Origin` header — confirming it came from
the extension rather than the page.

The server holds an `/events` request for up to 25 seconds; the client's own
timeout is 40, so an idle poll never fails spuriously.

### A cursor, and why a page starts from the present

`/events` is an append-only log with monotonic sequence numbers, so several
tabs can each track their own position without stealing each other's commands.

Two failure modes came out of that, both fixed and both regression-tested:

- **A fresh page must not start at cursor 0.** The log retains the last 256
  commands, so a page that had just loaded was handed the entire backlog and
  replayed it — including `open` and `back`, which navigate. `/health` reports
  the current cursor and the client starts there.
- **A page can outlive the daemon.** A restarted daemon begins its sequence at
  0 again while a long-lived tab still holds a much higher cursor, so it
  ignored everything until the new sequence caught up. The server clamps a
  cursor above its own to the present. Resetting to 0 instead would replay the
  log at the tab, which is the first bug again.

Commands are ephemeral input. Replaying them is never correct.

### No authentication, and why that is safe

The server binds `127.0.0.1` exclusively. That bind is the entire security
boundary — it is unreachable from off the machine, so there is nothing to
authenticate. Anything that widens it (binding another interface, adding CORS
headers, making the host configurable) removes the only thing protecting it.

One known limitation: a simple cross-origin `POST /state` does not trigger a
preflight, so any page you visit could write junk into the daemon's state
slot. Nothing reads that state today, so the impact is nil — but it stops
being nil if `/state` ever gains a consumer.

### Keys matched by scan code, and never suppressed

Hotkeys are matched on `(scan_code, is_keypad)` rather than by name, which is
what keeps numpad 8 distinct from the up arrow regardless of Num Lock.

Nothing is suppressed. Swallowing a key would take it from the focused game,
which defeats the entire purpose. `suppress=False` on the hook is load-bearing.

The hook is a single `keyboard.hook()` that dispatches on event type, not a
`keyboard.on_press` plus a `keyboard.on_release` pair. The library stops
dispatching as soon as a handler returns truthy, and its `on_press` wrapper
returns `True` for every key-up — which swallowed the release before a
separately registered `on_release` could ever see it. The auto-repeat guard
then never cleared and each key worked exactly once per daemon lifetime.

Only `faster` and `slower` repeat while held, so the speed ramps; everything
else fires once per physical press, so a finger resting on the toggle key
cannot strobe the scroller.

### State that deliberately does not persist

Speed lives in `sessionStorage`: it survives opening a thread and coming back,
but a new tab is a fresh start honouring `default_speed` from `config.json`.

Whether scrolling was running is **not** remembered at all. It was once, via
`GM_setValue`, which meant closing a tab mid-scroll made the next Reddit page
start scrolling by itself — and because a stored speed always won, the
configured `default_speed` only ever applied on the very first run.

Navigation always lands paused. Stopping the engine matters as much as
persisting, because the back-forward cache can restore a page without
re-running the script at all.

## Testing

Three suites, all gating CI:

- **Daemon** (78 tests, 100%) — pure logic plus the HTTP surface.
- **Userscript** (169 tests, ~97%) — the modules, plus `main.js` exercised by
  bundling it with esbuild into a fresh jsdom window per test. It exports
  nothing and runs on import, so that is the only way to reach it; a window
  per test is what stops listeners and timers leaking between cases.
- **Integration** (9 tests) — the real `Transport` against the real aiohttp
  server over real HTTP, substituting only the keyboard hook.

That last suite exists because every user-visible bug in this project lived in
the seam between the two halves, not inside either one. Both were well covered
against hand-written stubs of each other, which is precisely how the wire
contract drifted twice with every test still green.

## Known limitations

- **Windows only** for the daemon, which is built around Windows scan codes.
- **New Reddit only.** Posts are `<shreddit-post>` elements; if that changes,
  `selection.js` needs updating and the HUD says "no posts detected" meanwhile.
- **The port is defined twice** — `PORT` in `userscript/src/main.js` and `port`
  in `config.json` — and they must agree. Every fix considered was worse than
  the problem: the userscript cannot ask the daemon which port it is on without
  already knowing, and injecting it at build time would make the committed
  bundle depend on local config.
- **An elevated game needs an elevated daemon**, or Windows will not deliver
  hooked keys to it.
