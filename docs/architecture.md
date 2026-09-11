# Architecture

Why this is built the way it is. The code and its tests are authoritative for
*what* it does; this covers the *why*, and particularly why several obvious
alternatives were rejected.

## Two processes

```
┌─ Browser (monitor 2) ────────┐        ┌─ Python daemon ──────────────┐
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

### A userscript in your own browser, not an automated one

The obvious approach — Playwright or similar driving its own browser — forces
you to copy cookies and localStorage out of the real browser profile just to
stay logged in. That sync layer is most of the complexity, and it exists only
because the automated browser is not the browser you are already signed in to.
Running inside the real one removes the problem rather than solving it.

The cost is that Firefox will not permanently install an unsigned extension,
hence a userscript under Violentmonkey rather than a packaged add-on. That
choice also made the browser interchangeable: nothing in the page half is
engine-specific, and Chrome is supported on the same terms. The cross-browser
suite (`npm run test:browser`) runs the bundle in both.

### Long polling, not a WebSocket

`ws://127.0.0.1` from an `https://www.reddit.com` page is blocked as mixed
content, and userscript managers do not proxy WebSocket traffic through their
privileged context. `GM_xmlhttpRequest` does run in that context, so it is
neither mixed-content blocked nor CORS-restricted.

This was verified against a real daemon in Firefox before any other code was
written: a `GM_xmlhttpRequest` GET from reddit.com to `http://127.0.0.1:8765`
returns 200, and the server logs no `Origin` header — confirming it came from
the extension rather than the page. It is the one part the browser suite has to
substitute, since Playwright has no userscript manager to run it in; a browser
that applies its own policy to extension traffic bound for the local network
would show up here and nowhere else.

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
what keeps numpad 8 distinct from the up arrow regardless of Num Lock. Numpad
`/` is the sharper case: the main-row `/` on a US layout carries the same scan
code 53, and only `is_keypad` separates the two. Nothing binds it by default,
for reasons below, but it stays bindable and the collision stays tested.

Nothing is suppressed. Swallowing a key would take it from the focused
application, which defeats the entire purpose. `suppress=False` on the hook is
load-bearing.

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

### An off switch, and why it persists

Nothing scrolls unless you ask it to — the engine boots stopped and navigation
always lands paused. But two things kept acting on their own: the selection
outline re-computed on every scroll event, including your own wheel scrolling,
and the HUD was always drawn. "Leave me alone for a bit" was not expressible.

There is a sharper reason than tidiness. The hook is global and suppresses
nothing, which is the entire point — but it also means an application that uses
the numpad is driving the scroller whether or not you meant it to, and short of
killing the daemon there was no way to say no. `standby` is that no.

Dormant filters commands; it does not stop the poll. The wake key arrives over
the same `/events` request as everything else, so the transport keeps running
and the daemon keeps seeing the tab. Two commands are exempt: `standby` itself,
and `help` — which mutates nothing on the page, and whose panel is where the
wake key is written down.

The HUD collapses to its top row rather than vanishing. That row already
carries two independent facts — what the script is doing, and whether the
daemon is up — and both still matter when the answer to the first is "nothing".
A dormant script drawing zero pixels is indistinguishable from a broken one,
three weeks later, on a machine you have stopped thinking about.

That visible marker is also what makes the flag safe to persist, which the
section above might seem to forbid. It does not. The rule is that nothing which
makes the page *act* may be remembered; a switch that only ever makes it act
less is the opposite case. Storing "was running" made a page scroll by itself,
whereas storing "off" cannot start anything. It sits in GM storage beside
`rs-port`, surviving a restart and editable in the same manager UI.

Standby sits on numpad 1, and the first attempt did not. Numpad `/` was the
mnemonic choice, and its scan code checked out — but a key being *deliverable*
is not the same as a key being *free*. Firefox spends `/` on Quick Find, whose
find bar is browser chrome: it takes focus, the page stops receiving `keydown`,
and the fallback handler never sees the press that would switch the script back
on. Chrome has no such shortcut, so the binding would have behaved differently
in the two engines this project supports on equal terms — which is the part
that settles it, ahead of any workaround. A plain digit is claimed by nobody.

### One file, one version, one identity

The bundle in `userscript/dist/` is committed, and it is what people install.
CI rebuilds it from `src` and fails if the two differ, so the file a person
reads before installing is the code in this repository.

That file's `@updateURL` points at itself on `main`, which makes every merge a
potential update — but a userscript manager installs one only when `@version`
rises. A new bundle under an old version reaches nobody, and nothing announces
that it did not. So the version is written once, in `userscript/package.json`,
and the build copies it into the header; `pyproject.toml` carries the same
number, because both halves ship together.

Greasy Fork strips `@updateURL` and `@downloadURL` from scripts it hosts. An
install from there updates only from there, and one from GitHub only from
GitHub, so the two channels cannot overwrite each other.

`@namespace` is the one line that must not move. Managers identify a script by
`@name` plus `@namespace`, so changing either turns every existing install into
a second copy rather than an upgrade — and two copies of this script would both
act on every command, stepping the speed twice per press. It moved once, from a
private placeholder to the repository URL, before anything had an update
channel to break.

`@connect` names `127.0.0.1` and nothing else. The loopback bind is the whole
security boundary on the daemon's side, and a script permitted to reach
anywhere else would widen it from the other. `localhost` was listed alongside
it from the start and never used.

`userscript/tests/header.test.js` holds each of these to account, along with
Greasy Fork's own rules: no remote code, no minification, and a `@match` only
for the site the script actually works on.

## Testing

Four suites, all gating CI. No test counts or coverage figures are quoted
here on purpose: they move with every change, and a number in prose is a
number that goes quietly stale — this section said "three suites" and "169
tests" for a fortnight after neither was true. Coverage is enforced by
thresholds in `pyproject.toml` and `vitest.config.js`, which fail the build.
That is the fact worth stating; the percentage is in the CI run.

- **Daemon** — pure logic plus the HTTP surface.
- **Userscript** — the modules, plus `main.js` exercised by bundling it with
  esbuild into a fresh jsdom window per test. It exports nothing and runs on
  import, so that is the only way to reach it; a window per test is what stops
  listeners and timers leaking between cases.
- **Integration** — the real `Transport` against the real aiohttp server over
  real HTTP, substituting only the keyboard hook.
- **Browsers** — the built bundle in real Firefox and real Chromium, against a
  real daemon, so a behaviour that holds in one engine and not the other fails
  here rather than in someone's feed. It stands in for the hook the same way,
  and for `GM_xmlhttpRequest` as well, since Playwright has no userscript
  manager to run that in.

What it cannot reach is the browser's own chrome. Playwright dispatches keys
into content, so a shortcut the browser has claimed for itself is invisible
here — Firefox's Quick Find on `/` cost this project a binding, and no suite
saw it. Keys are worth trying by hand once, in both browsers, before they ship.

The last two exist because every user-visible bug in this project has lived in
a seam rather than inside a module. The two halves were each well covered
against a hand-written stub of the other, which is precisely how the wire
contract drifted twice with every test still green.

## Known limitations

- **Windows only** for the daemon, which is built around Windows scan codes.
- **New Reddit only.** Posts are `<shreddit-post>` elements; if that changes,
  `selection.js` needs updating and the HUD says "no posts detected" meanwhile.
- **The port is defined twice** — `port` in `config.json` and an `rs-port`
  value in GM storage — and they must agree. The duplication is unavoidable:
  the userscript cannot ask the daemon which port it is on without already
  knowing, and injecting it at build time would make the committed bundle
  depend on local config. What changed is the cost of disagreeing. The port
  used to be a constant compiled into the bundle, so moving it meant an npm
  install, a rebuild and a reinstall — and the daemon's own "port in use"
  message sent people to edit `config.json`, which silently left the page
  polling the old port with the repair gated behind a toolchain the setup
  otherwise avoids. Both sides are now editable in place.
- **An elevated application needs an elevated daemon**, or Windows will not
  deliver hooked keys to it.
