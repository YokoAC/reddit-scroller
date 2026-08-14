# Reddit Scroller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hands-free Reddit browsing on a second monitor — the feed auto-scrolls, and global numpad hotkeys pause it, change speed, and open or leave threads while a full-screen game keeps focus.

**Architecture:** A Violentmonkey userscript runs inside the user's real (already logged-in) Firefox and owns all page behaviour: the scroll engine, post selection, and an on-screen HUD. A Python daemon owns the global keyboard hook and exposes a loopback HTTP server; the userscript long-polls it for commands via `GM_xmlhttpRequest` and posts its state back. Neither half knows the other's internals — the contract is a small JSON command/state protocol.

**Tech Stack:** Python 3.13 (uv, aiohttp, keyboard, pytest) for the daemon; plain ES modules bundled by esbuild and tested with vitest + jsdom for the userscript.

## Global Constraints

- Python 3.13, managed with `uv`. All Python commands run as `uv run ...`.
- Target site is `https://www.reddit.com` only. Do not add old.reddit.com selectors.
- Firefox only. Do not add Chrome/Chromium compatibility code.
- The daemon binds `127.0.0.1` only — never `0.0.0.0`.
- Default port `8765`. Default speed `90` px/s. Speed range `15`–`600` px/s, step `15`. Focus line `0.25`.
- Hotkeys are matched by `(scan_code, is_keypad)`, never by key name.
- No hotkey is suppressed — the focused game must still receive every keystroke.
- Windows set-1 scan codes for the numpad: `0`=82, `1`=79, `2`=80, `3`=81, `4`=75, `5`=76, `6`=77, `7`=71, `8`=72, `9`=73, `.`=83, `+`=78, `-`=74, `*`=55, `Enter`=28. All have `is_keypad=True`.
- Command vocabulary is exactly: `toggle`, `open`, `back`, `faster`, `slower`, `prev`, `next`.
- `config.json` is gitignored. `config.example.json` is committed.
- Commit after every task. Use `feat:`, `test:`, `docs:`, `chore:` prefixes.

---

### Task 1: Retire the loopback transport risk

The entire transport design rests on one unverified assumption: that `GM_xmlhttpRequest` can reach `http://127.0.0.1` from an `https://www.reddit.com` page under Violentmonkey. If it cannot, the daemon must serve HTTPS with a self-signed certificate and every later task changes. Prove it before writing anything else.

This task is manual and needs the user at the keyboard.

**Files:**
- Create: `spike/server.py`
- Create: `spike/spike.user.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a verified yes/no on plain-HTTP loopback access. Nothing in this task survives into the final code.

- [ ] **Step 1: Write the throwaway server**

`spike/server.py`:

```python
"""Throwaway: does GM_xmlhttpRequest reach plain-HTTP loopback from reddit.com?"""

from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        print(f"HIT {self.path} origin={self.headers.get('Origin')!r}")
        body = b'{"ok": true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print("spike server on http://127.0.0.1:8765 — waiting for a hit")
    HTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
```

- [ ] **Step 2: Write the throwaway userscript**

`spike/spike.user.js`:

```javascript
// ==UserScript==
// @name         Loopback spike
// @namespace    local.reddit-scroller
// @version      0.0.1
// @match        https://www.reddit.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

GM_xmlhttpRequest({
  method: "GET",
  url: "http://127.0.0.1:8765/health",
  timeout: 5000,
  onload: (r) => alert("SPIKE OK " + r.status + " " + r.responseText),
  onerror: (e) => alert("SPIKE FAILED " + JSON.stringify(e)),
  ontimeout: () => alert("SPIKE TIMEOUT"),
});
```

- [ ] **Step 3: Run the spike**

Ask the user to:
1. Install Violentmonkey from addons.mozilla.org if it is not already installed.
2. Start the server: `uv run python spike/server.py`
3. Add `spike/spike.user.js` as a new userscript in Violentmonkey and save it.
4. Open `https://www.reddit.com` and report the alert text.

Expected: alert reads `SPIKE OK 200 {"ok": true}` and the server console prints a `HIT /health` line.

- [ ] **Step 4: Decide**

If the spike succeeded, continue with the plan unchanged.

If it failed, **stop and report to the user before continuing** — the design's fallback (self-signed HTTPS daemon, certificate imported into the Firefox profile) changes Tasks 4, 6, 10 and 12, and the plan needs revising first.

- [ ] **Step 5: Delete the spike and commit the result**

```bash
git rm -r --cached spike 2>/dev/null; rm -rf spike
git commit --allow-empty -m "chore: verify GM_xmlhttpRequest reaches plain-HTTP loopback"
```

---

### Task 2: Python scaffolding and configuration

**Files:**
- Create: `pyproject.toml`
- Create: `.python-version`
- Create: `src/reddit_scroller/__init__.py`
- Create: `src/reddit_scroller/config.py`
- Test: `tests/test_config.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `COMMANDS: frozenset[str]` — the seven command names.
  - `KEY_CODES: dict[str, tuple[int, bool]]` — key name → `(scan_code, is_keypad)`.
  - `class ConfigError(Exception)`.
  - `@dataclass(frozen=True) class KeyBinding: scan_code: int; is_keypad: bool`.
  - `@dataclass(frozen=True) class Config` with fields `port: int`, `default_speed: float`, `speed_step: float`, `speed_min: float`, `speed_max: float`, `focus_line: float`, `bindings: dict[str, KeyBinding]`.
  - `Config.default() -> Config` (classmethod).
  - `Config.lookup(scan_code: int, is_keypad: bool) -> str | None`.
  - `Config.browser_settings() -> dict` — the subset the userscript needs.
  - `load_config(path: pathlib.Path) -> Config` — returns `Config.default()` if the file does not exist; raises `ConfigError` on bad content.

- [ ] **Step 1: Create the project files**

`.python-version`:

```
3.13
```

`pyproject.toml`:

```toml
[project]
name = "reddit-scroller"
version = "0.1.0"
description = "Hands-free Reddit scrolling driven by global hotkeys"
requires-python = ">=3.13"
dependencies = [
    "aiohttp>=3.12",
    "keyboard>=0.13.5",
]

[dependency-groups]
dev = [
    "pytest>=8.3",
    "pytest-aiohttp>=1.1",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/reddit_scroller"]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
```

`src/reddit_scroller/__init__.py`:

```python
"""Hands-free Reddit scrolling driven by global hotkeys."""

__version__ = "0.1.0"
```

Then run `uv sync` to create the environment.

- [ ] **Step 2: Write the failing tests**

`tests/test_config.py`:

```python
import json

import pytest

from reddit_scroller.config import Config, ConfigError, KeyBinding, load_config


def test_defaults_match_the_spec():
    cfg = Config.default()
    assert cfg.port == 8765
    assert cfg.default_speed == 90.0
    assert cfg.speed_step == 15.0
    assert cfg.speed_min == 15.0
    assert cfg.speed_max == 600.0
    assert cfg.focus_line == 0.25


def test_default_bindings_cover_every_command():
    cfg = Config.default()
    assert set(cfg.bindings) == {
        "toggle",
        "open",
        "back",
        "faster",
        "slower",
        "prev",
        "next",
    }
    assert cfg.bindings["toggle"] == KeyBinding(scan_code=82, is_keypad=True)
    assert cfg.bindings["next"] == KeyBinding(scan_code=80, is_keypad=True)
    assert cfg.bindings["open"] == KeyBinding(scan_code=28, is_keypad=True)


def test_lookup_resolves_keypad_keys_and_ignores_their_non_keypad_twins():
    cfg = Config.default()
    assert cfg.lookup(80, is_keypad=True) == "next"
    # Scan code 80 with is_keypad False is the Down arrow, which is not ours.
    assert cfg.lookup(80, is_keypad=False) is None
    assert cfg.lookup(999, is_keypad=True) is None


def test_missing_file_yields_defaults(tmp_path):
    assert load_config(tmp_path / "nope.json") == Config.default()


def test_partial_file_overrides_only_named_fields(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"port": 9000, "default_speed": 120}))
    cfg = load_config(path)
    assert cfg.port == 9000
    assert cfg.default_speed == 120.0
    assert cfg.speed_step == 15.0
    assert cfg.bindings == Config.default().bindings


def test_partial_bindings_merge_over_defaults(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"bindings": {"toggle": "numpad5"}}))
    cfg = load_config(path)
    assert cfg.bindings["toggle"] == KeyBinding(scan_code=76, is_keypad=True)
    assert cfg.bindings["back"] == Config.default().bindings["back"]


def test_unknown_command_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"bindings": {"explode": "numpad5"}}))
    with pytest.raises(ConfigError, match="explode"):
        load_config(path)


def test_unknown_key_name_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"bindings": {"toggle": "banana"}}))
    with pytest.raises(ConfigError, match="banana"):
        load_config(path)


def test_duplicate_key_across_two_commands_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"bindings": {"toggle": "numpad2"}}))
    with pytest.raises(ConfigError, match="numpad2"):
        load_config(path)


def test_default_speed_outside_the_range_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"default_speed": 5}))
    with pytest.raises(ConfigError, match="default_speed"):
        load_config(path)


def test_focus_line_outside_the_viewport_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"focus_line": 1.5}))
    with pytest.raises(ConfigError, match="focus_line"):
        load_config(path)


def test_invalid_json_is_reported_as_a_config_error(tmp_path):
    path = tmp_path / "config.json"
    path.write_text("{not json")
    with pytest.raises(ConfigError, match="config.json"):
        load_config(path)


def test_an_unknown_setting_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"scroll_speed": 90}))
    with pytest.raises(ConfigError, match="scroll_speed"):
        load_config(path)


def test_a_non_numeric_setting_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"default_speed": "fast"}))
    with pytest.raises(ConfigError, match="default_speed"):
        load_config(path)


def test_browser_settings_carry_only_what_the_page_needs():
    assert Config.default().browser_settings() == {
        "speed_min": 15.0,
        "speed_max": 600.0,
        "speed_step": 15.0,
        "default_speed": 90.0,
        "focus_line": 0.25,
    }
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'reddit_scroller.config'`

- [ ] **Step 4: Write the implementation**

`src/reddit_scroller/config.py`:

```python
"""Loading and validation of the daemon's configuration."""

from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from pathlib import Path

COMMANDS = frozenset(
    {"toggle", "open", "back", "faster", "slower", "prev", "next"}
)

# Windows set-1 scan codes. Every numpad key also carries is_keypad=True, which
# is what separates numpad 8 from the up arrow regardless of Num Lock state.
KEY_CODES: dict[str, tuple[int, bool]] = {
    "numpad0": (82, True),
    "numpad1": (79, True),
    "numpad2": (80, True),
    "numpad3": (81, True),
    "numpad4": (75, True),
    "numpad5": (76, True),
    "numpad6": (77, True),
    "numpad7": (71, True),
    "numpad8": (72, True),
    "numpad9": (73, True),
    "numpad_dot": (83, True),
    "numpad_plus": (78, True),
    "numpad_minus": (74, True),
    "numpad_star": (55, True),
    "numpad_enter": (28, True),
}

DEFAULT_BINDINGS: dict[str, str] = {
    "toggle": "numpad0",
    "open": "numpad_enter",
    "back": "numpad_dot",
    "faster": "numpad_plus",
    "slower": "numpad_minus",
    "prev": "numpad8",
    "next": "numpad2",
}


class ConfigError(Exception):
    """Raised when config.json cannot be understood."""


@dataclass(frozen=True)
class KeyBinding:
    scan_code: int
    is_keypad: bool


@dataclass(frozen=True)
class Config:
    port: int = 8765
    default_speed: float = 90.0
    speed_step: float = 15.0
    speed_min: float = 15.0
    speed_max: float = 600.0
    focus_line: float = 0.25
    bindings: dict[str, KeyBinding] = field(default_factory=dict)

    @classmethod
    def default(cls) -> "Config":
        return cls(bindings=_resolve_bindings(DEFAULT_BINDINGS))

    def lookup(self, scan_code: int, is_keypad: bool) -> str | None:
        """Return the command bound to a physical key, or None."""
        for command, binding in self.bindings.items():
            if binding.scan_code == scan_code and binding.is_keypad == is_keypad:
                return command
        return None

    def browser_settings(self) -> dict:
        """The subset of config the userscript needs to know about."""
        return {
            "speed_min": self.speed_min,
            "speed_max": self.speed_max,
            "speed_step": self.speed_step,
            "default_speed": self.default_speed,
            "focus_line": self.focus_line,
        }


def _resolve_bindings(names: dict[str, str]) -> dict[str, KeyBinding]:
    resolved: dict[str, KeyBinding] = {}
    seen: dict[str, str] = {}
    for command, key_name in names.items():
        if command not in COMMANDS:
            raise ConfigError(
                f"unknown command {command!r} in bindings; "
                f"expected one of {sorted(COMMANDS)}"
            )
        if key_name not in KEY_CODES:
            raise ConfigError(
                f"unknown key {key_name!r} for command {command!r}; "
                f"expected one of {sorted(KEY_CODES)}"
            )
        if key_name in seen:
            raise ConfigError(
                f"key {key_name!r} is bound to both {seen[key_name]!r} "
                f"and {command!r}"
            )
        seen[key_name] = command
        scan_code, is_keypad = KEY_CODES[key_name]
        resolved[command] = KeyBinding(scan_code=scan_code, is_keypad=is_keypad)
    return resolved


def _validate(cfg: Config) -> None:
    if not 1 <= cfg.port <= 65535:
        raise ConfigError(f"port must be between 1 and 65535, got {cfg.port}")
    if cfg.speed_min <= 0:
        raise ConfigError(f"speed_min must be positive, got {cfg.speed_min}")
    if cfg.speed_max <= cfg.speed_min:
        raise ConfigError(
            f"speed_max ({cfg.speed_max}) must exceed speed_min ({cfg.speed_min})"
        )
    if cfg.speed_step <= 0:
        raise ConfigError(f"speed_step must be positive, got {cfg.speed_step}")
    if not cfg.speed_min <= cfg.default_speed <= cfg.speed_max:
        raise ConfigError(
            f"default_speed ({cfg.default_speed}) must lie between "
            f"speed_min ({cfg.speed_min}) and speed_max ({cfg.speed_max})"
        )
    if not 0.0 < cfg.focus_line < 1.0:
        raise ConfigError(
            f"focus_line must be between 0 and 1 exclusive, got {cfg.focus_line}"
        )


def load_config(path: Path) -> Config:
    """Load config from *path*, falling back to defaults when it is absent."""
    if not path.exists():
        return Config.default()

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{path.name} is not valid JSON: {exc}") from exc

    if not isinstance(raw, dict):
        raise ConfigError(f"{path.name} must contain a JSON object")

    binding_names = dict(DEFAULT_BINDINGS)
    binding_names.update(raw.pop("bindings", {}))

    known = {f for f in Config.__dataclass_fields__ if f != "bindings"}
    unknown = set(raw) - known
    if unknown:
        raise ConfigError(f"unknown setting(s): {', '.join(sorted(unknown))}")

    numeric: dict[str, float | int] = {}
    for key, value in raw.items():
        try:
            numeric[key] = int(value) if key == "port" else float(value)
        except (TypeError, ValueError) as exc:
            raise ConfigError(f"{key} must be a number, got {value!r}") from exc

    cfg = replace(
        Config.default(),
        bindings=_resolve_bindings(binding_names),
        **numeric,
    )
    _validate(cfg)
    return cfg
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_config.py -v`
Expected: PASS, 15 tests.

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml uv.lock .python-version src/reddit_scroller tests/test_config.py
git commit -m "feat: add project scaffolding and configuration loading"
```

---

### Task 3: The event bus

The bus is the seam between the keyboard thread and the asyncio server. It is an append-only log with monotonic sequence numbers so that any number of browser tabs can each track their own cursor and never miss or double-handle a command.

**Files:**
- Create: `src/reddit_scroller/bus.py`
- Test: `tests/test_bus.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `@dataclass(frozen=True) class Event: seq: int; command: str` with `.as_dict() -> dict`.
  - `class EventBus`:
    - `__init__(self, max_events: int = 256)`
    - `bind_loop(self, loop: asyncio.AbstractEventLoop) -> None`
    - `cursor: int` (property) — the newest sequence number, `0` when empty.
    - `append(self, command: str) -> Event` — loop thread only.
    - `append_threadsafe(self, command: str) -> None` — any thread.
    - `since(self, cursor: int) -> list[Event]`
    - `async wait_for(self, cursor: int, timeout: float) -> list[Event]`
    - `set_state(self, state: dict) -> None` / `get_state(self) -> dict`

- [ ] **Step 1: Write the failing tests**

`tests/test_bus.py`:

```python
import asyncio

import pytest

from reddit_scroller.bus import EventBus


def test_empty_bus_has_a_zero_cursor():
    assert EventBus().cursor == 0


def test_sequence_numbers_start_at_one_and_increase():
    bus = EventBus()
    assert bus.append("toggle").seq == 1
    assert bus.append("faster").seq == 2
    assert bus.cursor == 2


def test_since_returns_exactly_the_unseen_tail():
    bus = EventBus()
    bus.append("toggle")
    bus.append("faster")
    bus.append("next")
    assert [e.command for e in bus.since(0)] == ["toggle", "faster", "next"]
    assert [e.command for e in bus.since(2)] == ["next"]
    assert bus.since(3) == []


def test_two_cursors_advance_independently():
    bus = EventBus()
    bus.append("toggle")
    slow, fast = 0, bus.cursor
    bus.append("next")
    assert len(bus.since(slow)) == 2
    assert len(bus.since(fast)) == 1


def test_the_log_is_bounded():
    bus = EventBus(max_events=3)
    for _ in range(10):
        bus.append("toggle")
    assert len(bus.since(0)) == 3
    assert bus.cursor == 10


def test_event_serialises_for_the_wire():
    assert EventBus().append("open").as_dict() == {"seq": 1, "command": "open"}


async def test_wait_for_returns_immediately_when_events_are_pending():
    bus = EventBus()
    bus.append("toggle")
    events = await asyncio.wait_for(bus.wait_for(0, timeout=5.0), timeout=1.0)
    assert [e.command for e in events] == ["toggle"]


async def test_wait_for_wakes_on_a_later_append():
    bus = EventBus()

    async def append_soon():
        await asyncio.sleep(0.01)
        bus.append("faster")

    asyncio.create_task(append_soon())
    events = await asyncio.wait_for(bus.wait_for(0, timeout=5.0), timeout=1.0)
    assert [e.command for e in events] == ["faster"]


async def test_wait_for_returns_empty_on_timeout():
    bus = EventBus()
    assert await bus.wait_for(0, timeout=0.01) == []


async def test_every_waiter_wakes_on_one_append():
    bus = EventBus()
    waiters = [asyncio.create_task(bus.wait_for(0, timeout=5.0)) for _ in range(3)]
    await asyncio.sleep(0.01)
    bus.append("back")
    results = await asyncio.wait_for(asyncio.gather(*waiters), timeout=1.0)
    assert all([e.command for e in r] == ["back"] for r in results)


async def test_append_threadsafe_reaches_a_waiter_from_another_thread():
    bus = EventBus()
    bus.bind_loop(asyncio.get_running_loop())
    waiter = asyncio.create_task(bus.wait_for(0, timeout=5.0))
    await asyncio.sleep(0.01)
    await asyncio.to_thread(bus.append_threadsafe, "slower")
    events = await asyncio.wait_for(waiter, timeout=1.0)
    assert [e.command for e in events] == ["slower"]


def test_append_threadsafe_without_a_loop_is_an_error():
    with pytest.raises(RuntimeError, match="loop"):
        EventBus().append_threadsafe("toggle")


def test_state_round_trips_and_defaults_to_empty():
    bus = EventBus()
    assert bus.get_state() == {}
    bus.set_state({"running": True, "speed": 90})
    assert bus.get_state() == {"running": True, "speed": 90}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_bus.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'reddit_scroller.bus'`

- [ ] **Step 3: Write the implementation**

`src/reddit_scroller/bus.py`:

```python
"""The append-only command log shared by the hotkey hook and the HTTP server."""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass


@dataclass(frozen=True)
class Event:
    seq: int
    command: str

    def as_dict(self) -> dict:
        return {"seq": self.seq, "command": self.command}


class EventBus:
    """A bounded event log with independent per-client cursors.

    Browser tabs poll with the sequence number they last saw, so a tab that
    was asleep catches up rather than missing commands, and two tabs never
    steal each other's events.
    """

    def __init__(self, max_events: int = 256) -> None:
        self._events: deque[Event] = deque(maxlen=max_events)
        self._seq = 0
        self._state: dict = {}
        self._waiters: list[asyncio.Future] = []
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    @property
    def cursor(self) -> int:
        return self._seq

    def append(self, command: str) -> Event:
        """Append a command. Must be called on the event loop's thread."""
        self._seq += 1
        event = Event(seq=self._seq, command=command)
        self._events.append(event)
        waiters, self._waiters = self._waiters, []
        for waiter in waiters:
            if not waiter.done():
                waiter.set_result(None)
        return event

    def append_threadsafe(self, command: str) -> None:
        """Append from any thread — used by the keyboard hook."""
        if self._loop is None:
            raise RuntimeError("EventBus has no bound loop; call bind_loop() first")
        self._loop.call_soon_threadsafe(self.append, command)

    def since(self, cursor: int) -> list[Event]:
        return [event for event in self._events if event.seq > cursor]

    async def wait_for(self, cursor: int, timeout: float) -> list[Event]:
        """Return events after *cursor*, waiting up to *timeout* seconds."""
        pending = self.since(cursor)
        if pending:
            return pending

        waiter = asyncio.get_running_loop().create_future()
        self._waiters.append(waiter)
        try:
            await asyncio.wait_for(waiter, timeout)
        except (TimeoutError, asyncio.TimeoutError):
            pass
        finally:
            if waiter in self._waiters:
                self._waiters.remove(waiter)
        return self.since(cursor)

    def set_state(self, state: dict) -> None:
        self._state = state

    def get_state(self) -> dict:
        return self._state
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_bus.py -v`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/reddit_scroller/bus.py tests/test_bus.py
git commit -m "feat: add the cursor-based command event bus"
```

---

### Task 4: The HTTP server

**Files:**
- Create: `src/reddit_scroller/server.py`
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes: `EventBus` (Task 3), `Config` (Task 2).
- Produces: `create_app(bus: EventBus, settings: dict, poll_timeout: float = 25.0) -> aiohttp.web.Application`.

Wire protocol:
- `GET /health` → `200 {"ok": true, "settings": {...}}` where `settings` is `Config.browser_settings()`.
- `GET /events?cursor=N` → `200 {"cursor": M, "events": [{"seq": .., "command": ".."}]}`. Holds the request up to `poll_timeout` seconds when nothing is pending, then returns an empty list with the cursor unchanged. A missing or unparseable `cursor` is treated as `0`.
- `POST /state` with a JSON object body → `200 {"ok": true}`; a non-object body or invalid JSON → `400 {"ok": false, "error": "..."}`.
- `GET /state` → `200` with the last posted state object.

- [ ] **Step 1: Write the failing tests**

`tests/test_server.py`:

```python
import asyncio

import pytest

from reddit_scroller.bus import EventBus
from reddit_scroller.config import Config
from reddit_scroller.server import create_app


@pytest.fixture
def bus():
    return EventBus()


@pytest.fixture
async def client(aiohttp_client, bus):
    app = create_app(bus, Config.default().browser_settings(), poll_timeout=0.05)
    return await aiohttp_client(app)


async def test_health_reports_ok_and_the_browser_settings(client):
    resp = await client.get("/health")
    assert resp.status == 200
    body = await resp.json()
    assert body["ok"] is True
    assert body["settings"]["default_speed"] == 90.0
    assert body["settings"]["focus_line"] == 0.25


async def test_events_returns_pending_commands_and_the_new_cursor(client, bus):
    bus.append("toggle")
    bus.append("faster")
    resp = await client.get("/events", params={"cursor": "0"})
    assert resp.status == 200
    body = await resp.json()
    assert body["cursor"] == 2
    assert [e["command"] for e in body["events"]] == ["toggle", "faster"]


async def test_events_honours_the_cursor(client, bus):
    bus.append("toggle")
    bus.append("faster")
    body = await (await client.get("/events", params={"cursor": "1"})).json()
    assert [e["command"] for e in body["events"]] == ["faster"]


async def test_events_times_out_with_an_empty_list_and_an_unchanged_cursor(client):
    body = await (await client.get("/events", params={"cursor": "0"})).json()
    assert body == {"cursor": 0, "events": []}


async def test_events_returns_as_soon_as_a_command_arrives(client, bus):
    app = client.app
    app["poll_timeout"] = 5.0

    async def append_soon():
        await asyncio.sleep(0.01)
        bus.append("open")

    asyncio.create_task(append_soon())
    body = await (await client.get("/events", params={"cursor": "0"})).json()
    assert [e["command"] for e in body["events"]] == ["open"]


async def test_a_missing_cursor_is_treated_as_zero(client, bus):
    bus.append("back")
    body = await (await client.get("/events")).json()
    assert [e["command"] for e in body["events"]] == ["back"]


async def test_a_junk_cursor_is_treated_as_zero(client, bus):
    bus.append("back")
    body = await (await client.get("/events", params={"cursor": "abc"})).json()
    assert [e["command"] for e in body["events"]] == ["back"]


async def test_state_round_trips(client, bus):
    resp = await client.post("/state", json={"running": True, "speed": 105})
    assert resp.status == 200
    assert (await resp.json())["ok"] is True
    assert bus.get_state() == {"running": True, "speed": 105}
    assert await (await client.get("/state")).json() == {"running": True, "speed": 105}


async def test_a_non_object_state_body_is_rejected(client):
    resp = await client.post("/state", json=[1, 2, 3])
    assert resp.status == 400
    assert (await resp.json())["ok"] is False


async def test_an_invalid_json_state_body_is_rejected(client):
    resp = await client.post(
        "/state", data="{not json", headers={"Content-Type": "application/json"}
    )
    assert resp.status == 400
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_server.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'reddit_scroller.server'`

- [ ] **Step 3: Write the implementation**

`src/reddit_scroller/server.py`:

```python
"""The loopback HTTP server the userscript long-polls for commands."""

from __future__ import annotations

import json

from aiohttp import web

from .bus import EventBus


def _cursor_from(request: web.Request) -> int:
    try:
        return max(0, int(request.query.get("cursor", "0")))
    except (TypeError, ValueError):
        return 0


async def _health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "settings": request.app["settings"]})


async def _events(request: web.Request) -> web.Response:
    bus: EventBus = request.app["bus"]
    cursor = _cursor_from(request)
    events = await bus.wait_for(cursor, timeout=request.app["poll_timeout"])
    new_cursor = events[-1].seq if events else cursor
    return web.json_response(
        {"cursor": new_cursor, "events": [event.as_dict() for event in events]}
    )


async def _post_state(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except (json.JSONDecodeError, ValueError):
        return web.json_response(
            {"ok": False, "error": "body is not valid JSON"}, status=400
        )
    if not isinstance(payload, dict):
        return web.json_response(
            {"ok": False, "error": "body must be a JSON object"}, status=400
        )
    request.app["bus"].set_state(payload)
    return web.json_response({"ok": True})


async def _get_state(request: web.Request) -> web.Response:
    return web.json_response(request.app["bus"].get_state())


def create_app(
    bus: EventBus, settings: dict, poll_timeout: float = 25.0
) -> web.Application:
    app = web.Application()
    app["bus"] = bus
    app["settings"] = settings
    app["poll_timeout"] = poll_timeout
    app.add_routes(
        [
            web.get("/health", _health),
            web.get("/events", _events),
            web.get("/state", _get_state),
            web.post("/state", _post_state),
        ]
    )
    return app
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_server.py -v`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/reddit_scroller/server.py tests/test_server.py
git commit -m "feat: add the loopback long-poll HTTP server"
```

---

### Task 5: The global hotkey hook

**Files:**
- Create: `src/reddit_scroller/hotkeys.py`
- Test: `tests/test_hotkeys.py`

**Interfaces:**
- Consumes: `Config` (Task 2).
- Produces: `class HotkeyListener`:
  - `__init__(self, config: Config, on_command: Callable[[str], None])`
  - `handle_press(self, event) -> str | None` — pure dispatch; `event` needs `.scan_code` and `.is_keypad`. Returns the command it fired, or `None`.
  - `handle_release(self, event) -> None`
  - `start(self) -> None` / `stop(self) -> None` — install and remove the real hook.

The `keyboard` import lives inside `start()`, so the tests never touch a real hook and the module imports cleanly anywhere.

Auto-repeat matters here: holding a key makes Windows emit a stream of key-down events. A key must be released before it can fire again, otherwise resting a finger on numpad `0` would strobe the scroller.

- [ ] **Step 1: Write the failing tests**

`tests/test_hotkeys.py`:

```python
from types import SimpleNamespace

from reddit_scroller.config import Config
from reddit_scroller.hotkeys import HotkeyListener


def key(scan_code: int, is_keypad: bool = True) -> SimpleNamespace:
    return SimpleNamespace(scan_code=scan_code, is_keypad=is_keypad, name=None)


def listener() -> tuple[HotkeyListener, list[str]]:
    fired: list[str] = []
    return HotkeyListener(Config.default(), fired.append), fired


def test_a_bound_key_fires_its_command():
    hk, fired = listener()
    assert hk.handle_press(key(82)) == "toggle"
    assert fired == ["toggle"]


def test_every_default_binding_is_reachable():
    hk, fired = listener()
    for scan_code in (82, 28, 83, 78, 74, 72, 80):
        hk.handle_press(key(scan_code))
        hk.handle_release(key(scan_code))
    assert fired == ["toggle", "open", "back", "faster", "slower", "prev", "next"]


def test_an_unbound_key_fires_nothing():
    hk, fired = listener()
    assert hk.handle_press(key(30)) is None
    assert fired == []


def test_the_non_keypad_twin_of_a_bound_key_fires_nothing():
    hk, fired = listener()
    # Scan code 72 without the keypad flag is the up arrow, not numpad 8.
    assert hk.handle_press(key(72, is_keypad=False)) is None
    assert fired == []


def test_auto_repeat_while_held_fires_only_once():
    hk, fired = listener()
    for _ in range(5):
        hk.handle_press(key(82))
    assert fired == ["toggle"]


def test_the_key_fires_again_after_release():
    hk, fired = listener()
    hk.handle_press(key(82))
    hk.handle_release(key(82))
    hk.handle_press(key(82))
    assert fired == ["toggle", "toggle"]


def test_holding_one_key_does_not_block_another():
    hk, fired = listener()
    hk.handle_press(key(82))
    hk.handle_press(key(78))
    assert fired == ["toggle", "faster"]


def test_releasing_an_unpressed_key_is_harmless():
    hk, fired = listener()
    hk.handle_release(key(82))
    assert fired == []


def test_an_event_without_the_keypad_attribute_is_treated_as_non_keypad():
    hk, fired = listener()
    assert hk.handle_press(SimpleNamespace(scan_code=82)) is None
    assert fired == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_hotkeys.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'reddit_scroller.hotkeys'`

- [ ] **Step 3: Write the implementation**

`src/reddit_scroller/hotkeys.py`:

```python
"""The global keyboard hook that turns numpad presses into commands."""

from __future__ import annotations

from collections.abc import Callable

from .config import Config


class HotkeyListener:
    """Dispatches physical key events to command names.

    Keys are matched on (scan_code, is_keypad) rather than by name so that
    numpad 8 stays distinct from the up arrow whatever Num Lock is doing.
    Nothing is suppressed — a focused game still receives every keystroke.
    """

    def __init__(self, config: Config, on_command: Callable[[str], None]) -> None:
        self._config = config
        self._on_command = on_command
        self._held: set[tuple[int, bool]] = set()
        self._hooks: list = []

    @staticmethod
    def _identity(event) -> tuple[int, bool]:
        return (getattr(event, "scan_code", -1), bool(getattr(event, "is_keypad", False)))

    def handle_press(self, event) -> str | None:
        identity = self._identity(event)
        if identity in self._held:
            return None  # Windows auto-repeat, not a new press.
        command = self._config.lookup(*identity)
        if command is None:
            return None
        self._held.add(identity)
        self._on_command(command)
        return command

    def handle_release(self, event) -> None:
        self._held.discard(self._identity(event))

    def start(self) -> None:
        import keyboard

        self._hooks = [
            keyboard.on_press(self.handle_press, suppress=False),
            keyboard.on_release(self.handle_release, suppress=False),
        ]

    def stop(self) -> None:
        import keyboard

        for hook in self._hooks:
            keyboard.unhook(hook)
        self._hooks = []
        self._held.clear()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_hotkeys.py -v`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/reddit_scroller/hotkeys.py tests/test_hotkeys.py
git commit -m "feat: add the global numpad hotkey listener"
```

---

### Task 6: Daemon entry point

This task makes the daemon a runnable program. Its test is an end-to-end check that a real server, bus and (fake) key press hand a command to a real HTTP client.

**Files:**
- Create: `src/reddit_scroller/__main__.py`
- Create: `config.example.json`
- Test: `tests/test_daemon.py`

**Interfaces:**
- Consumes: `Config`, `load_config` (Task 2); `EventBus` (Task 3); `create_app` (Task 4); `HotkeyListener` (Task 5).
- Produces:
  - `CONFIG_PATH: pathlib.Path` — repository root `config.json`.
  - `async run(config: Config, listener_factory=HotkeyListener) -> None`
  - `main() -> int`

- [ ] **Step 1: Write the failing test**

`tests/test_daemon.py`:

```python
import asyncio
from dataclasses import replace

import aiohttp
import pytest

from reddit_scroller.__main__ import run
from reddit_scroller.config import Config


class FakeListener:
    """Stands in for the real keyboard hook — no OS hook is installed."""

    instances: list["FakeListener"] = []

    def __init__(self, config, on_command):
        self.config = config
        self.on_command = on_command
        self.started = False
        FakeListener.instances.append(self)

    def start(self):
        self.started = True

    def stop(self):
        self.started = False


@pytest.fixture(autouse=True)
def clear_instances():
    FakeListener.instances.clear()
    yield
    FakeListener.instances.clear()


async def test_a_key_press_reaches_a_polling_http_client():
    # Port 0 is not usable here because the client needs to know the port, so
    # pick one well away from the default to avoid clashing with a live daemon.
    config = replace(Config.default(), port=8799)

    task = asyncio.create_task(run(config, listener_factory=FakeListener))
    await asyncio.sleep(0.2)

    try:
        assert FakeListener.instances, "the listener was never constructed"
        listener = FakeListener.instances[0]
        assert listener.started is True

        async with aiohttp.ClientSession() as session:
            async with session.get("http://127.0.0.1:8799/health") as resp:
                assert (await resp.json())["ok"] is True

            poll = asyncio.create_task(
                session.get("http://127.0.0.1:8799/events?cursor=0")
            )
            await asyncio.sleep(0.05)
            listener.on_command("toggle")  # as if numpad 0 were pressed

            resp = await asyncio.wait_for(poll, timeout=2.0)
            body = await resp.json()
            resp.close()
            assert [e["command"] for e in body["events"]] == ["toggle"]
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


async def test_the_port_being_busy_raises_a_clear_error():
    config = replace(Config.default(), port=8798)

    first = asyncio.create_task(run(config, listener_factory=FakeListener))
    await asyncio.sleep(0.2)
    try:
        with pytest.raises(OSError):
            await asyncio.wait_for(
                run(config, listener_factory=FakeListener), timeout=2.0
            )
        # The failed start must not have installed a second keyboard hook.
        assert len(FakeListener.instances) == 1
    finally:
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_daemon.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'reddit_scroller.__main__'`

- [ ] **Step 3: Write the implementation**

`src/reddit_scroller/__main__.py`:

```python
"""Daemon entry point: wires the hotkey hook to the loopback server."""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime
from pathlib import Path

from aiohttp import web

from .bus import EventBus
from .config import Config, ConfigError, load_config
from .hotkeys import HotkeyListener
from .server import create_app

CONFIG_PATH = Path(__file__).resolve().parents[2] / "config.json"


def log(message: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {message}", flush=True)


async def run(config: Config, listener_factory=HotkeyListener) -> None:
    bus = EventBus()
    bus.bind_loop(asyncio.get_running_loop())

    def on_command(command: str) -> None:
        log(f"hotkey  {command}")
        bus.append_threadsafe(command)

    app = create_app(bus, config.browser_settings())
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", config.port)
    try:
        await site.start()
    except OSError:
        await runner.cleanup()
        raise

    # Only hook the keyboard once the port is ours — a failed start must not
    # leave a global hook installed.
    listener = listener_factory(config, on_command)
    listener.start()

    log(f"listening on http://127.0.0.1:{config.port}")
    for command, binding in sorted(config.bindings.items()):
        log(f"  {command:<7} scan={binding.scan_code} keypad={binding.is_keypad}")
    log("waiting for the userscript to connect (Ctrl+C to stop)")

    try:
        await asyncio.Event().wait()
    finally:
        listener.stop()
        await runner.cleanup()


def main() -> int:
    try:
        config = load_config(CONFIG_PATH)
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 1

    if not CONFIG_PATH.exists():
        log(f"no {CONFIG_PATH.name} found — using defaults")

    try:
        asyncio.run(run(config))
    except KeyboardInterrupt:
        log("stopped")
    except OSError as exc:
        print(
            f"could not bind 127.0.0.1:{config.port} ({exc}). "
            "Another daemon may already be running, or change 'port' in config.json.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

`config.example.json`:

```json
{
  "port": 8765,
  "default_speed": 90,
  "speed_step": 15,
  "speed_min": 15,
  "speed_max": 600,
  "focus_line": 0.25,
  "bindings": {
    "toggle": "numpad0",
    "open": "numpad_enter",
    "back": "numpad_dot",
    "faster": "numpad_plus",
    "slower": "numpad_minus",
    "prev": "numpad8",
    "next": "numpad2"
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -v`
Expected: PASS, all 40 tests across the four test files.

- [ ] **Step 5: Verify the daemon runs for real**

Run: `uv run python -m reddit_scroller`

Expected: it prints the listening line and the seven bindings. In a second terminal, `curl http://127.0.0.1:8765/health` returns `{"ok": true, "settings": {...}}`. Press numpad `0` and confirm a `hotkey toggle` line appears. Stop it with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add src/reddit_scroller/__main__.py config.example.json tests/test_daemon.py
git commit -m "feat: add the daemon entry point"
```

---

### Task 7: Userscript toolchain and the scroll engine

**Files:**
- Create: `userscript/package.json`
- Create: `userscript/build.mjs`
- Create: `userscript/vitest.config.js`
- Create: `userscript/src/scroll.js`
- Test: `userscript/tests/scroll.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces from `scroll.js`:
  - `clampSpeed(speed: number, min: number, max: number) -> number`
  - `class ScrollEngine`:
    - `constructor({ scrollBy, requestFrame, cancelFrame, speed, min, max, step })` — the three functions are injectable so tests never need a browser.
    - `running: boolean` (getter), `speed: number` (getter), `step: number` (getter)
    - `setSpeed(pxPerSecond)`, `adjustSpeed(delta)`, `setLimits(min, max)`, `start()`, `stop()`, `toggle()`
    - `tick(timestampMs)` — advances one frame; public so tests can drive it.

`setLimits` exists because the engine is constructed from built-in defaults before
`/health` has answered. When the daemon reports the user's configured `speed_min` and
`speed_max`, the engine has to adopt them — otherwise those two config fields would
silently do nothing.
  - `MAX_FRAME_SECONDS = 0.1`

Speed is in pixels per second and multiplied by the real frame delta, so it does not change with refresh rate. Fractional pixels accumulate across frames so that 15 px/s is still smooth rather than a stutter of 1px jumps.

- [ ] **Step 1: Create the toolchain**

`userscript/package.json`:

```json
{
  "name": "reddit-scroller-userscript",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "node build.mjs",
    "test": "vitest run"
  },
  "devDependencies": {
    "esbuild": "^0.25.0",
    "jsdom": "^26.0.0",
    "vitest": "^3.0.0"
  }
}
```

`userscript/vitest.config.js`:

```javascript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    environmentMatchGlobs: [["tests/*.dom.test.js", "jsdom"]],
    include: ["tests/**/*.test.js"],
  },
});
```

`userscript/build.mjs`:

```javascript
import { build } from "esbuild";

const BANNER = `// ==UserScript==
// @name         Reddit Scroller
// @namespace    local.reddit-scroller
// @version      0.1.0
// @description  Hands-free Reddit scrolling driven by global hotkeys
// @match        https://www.reddit.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==`;

await build({
  entryPoints: ["src/main.js"],
  outfile: "dist/reddit-scroller.user.js",
  bundle: true,
  format: "iife",
  target: "firefox115",
  banner: { js: BANNER },
  legalComments: "none",
});

console.log("built dist/reddit-scroller.user.js");
```

Create a placeholder `userscript/src/main.js` so the build has an entry point — Task 11 replaces it:

```javascript
// Replaced in Task 11.
export {};
```

Then run `npm install` inside `userscript/`.

- [ ] **Step 2: Write the failing tests**

`userscript/tests/scroll.test.js`:

```javascript
import { describe, expect, it } from "vitest";
import { ScrollEngine, clampSpeed } from "../src/scroll.js";

function makeEngine(overrides = {}) {
  const moves = [];
  const frames = [];
  const engine = new ScrollEngine({
    scrollBy: (dy) => moves.push(dy),
    requestFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancelFrame: () => {},
    speed: 100,
    min: 15,
    max: 600,
    step: 15,
    ...overrides,
  });
  return { engine, moves, frames };
}

describe("clampSpeed", () => {
  it("passes values inside the range through", () => {
    expect(clampSpeed(90, 15, 600)).toBe(90);
  });

  it("clamps below the minimum", () => {
    expect(clampSpeed(1, 15, 600)).toBe(15);
  });

  it("clamps above the maximum", () => {
    expect(clampSpeed(9000, 15, 600)).toBe(600);
  });
});

describe("ScrollEngine", () => {
  it("starts stopped", () => {
    const { engine, moves } = makeEngine();
    expect(engine.running).toBe(false);
    expect(moves).toEqual([]);
  });

  it("does not scroll on the first frame, which has no delta", () => {
    const { engine, moves } = makeEngine();
    engine.start();
    engine.tick(1000);
    expect(moves).toEqual([]);
  });

  it("scrolls speed multiplied by the frame delta", () => {
    const { engine, moves } = makeEngine({ speed: 100 });
    engine.start();
    engine.tick(1000);
    engine.tick(1050); // 0.05s at 100 px/s — under the MAX_FRAME_SECONDS cap
    expect(moves).toEqual([5]);
  });

  it("accumulates sub-pixel remainders instead of dropping them", () => {
    // 32 px/s at 1/64 s per frame is exactly 0.5 px per frame. Both operands
    // are binary-exact, so this asserts the accumulator's behaviour without
    // floating-point drift deciding the outcome: whole pixels come out every
    // second frame and nothing is lost to truncation.
    const { engine, moves } = makeEngine({ speed: 32 });
    engine.start();
    engine.tick(0);
    for (let i = 1; i <= 4; i += 1) engine.tick(i * 15.625);
    expect(moves).toEqual([1, 1]);
    expect(moves.every(Number.isInteger)).toBe(true);
  });

  it("clamps a huge delta so a backgrounded tab does not lurch", () => {
    const { engine, moves } = makeEngine({ speed: 100 });
    engine.start();
    engine.tick(0);
    engine.tick(60000); // one minute later
    expect(moves).toEqual([10]); // 0.1s cap at 100 px/s
  });

  it("stops scrolling and requesting frames when stopped", () => {
    const { engine, moves, frames } = makeEngine();
    engine.start();
    engine.tick(0);
    engine.stop();
    const framesRequested = frames.length;
    engine.tick(1000);
    expect(engine.running).toBe(false);
    expect(moves).toEqual([]);
    expect(frames.length).toBe(framesRequested);
  });

  it("toggles between running and stopped", () => {
    const { engine } = makeEngine();
    expect(engine.toggle()).toBe(true);
    expect(engine.running).toBe(true);
    expect(engine.toggle()).toBe(false);
    expect(engine.running).toBe(false);
  });

  it("starting twice does not stack two frame loops", () => {
    const { engine, frames } = makeEngine();
    engine.start();
    const after = frames.length;
    engine.start();
    expect(frames.length).toBe(after);
  });

  it("clamps the speed it is given", () => {
    const { engine } = makeEngine();
    engine.setSpeed(9999);
    expect(engine.speed).toBe(600);
    engine.setSpeed(0);
    expect(engine.speed).toBe(15);
  });

  it("adjusts speed by a delta, clamped", () => {
    const { engine } = makeEngine({ speed: 100 });
    engine.adjustSpeed(15);
    expect(engine.speed).toBe(115);
    engine.adjustSpeed(-1000);
    expect(engine.speed).toBe(15);
  });

  it("adopts new limits and re-clamps the current speed", () => {
    const { engine } = makeEngine({ speed: 100 });
    engine.setLimits(200, 1000);
    expect(engine.speed).toBe(200);
    engine.setSpeed(900);
    expect(engine.speed).toBe(900);
  });

  it("resets the accumulator on a speed change so it does not jump", () => {
    const { engine, moves } = makeEngine({ speed: 15 });
    engine.start();
    engine.tick(0);
    engine.tick(30); // accumulates ~0.45px, scrolls nothing
    expect(moves).toEqual([]);
    engine.setSpeed(600);
    engine.tick(60); // 0.03s at 600 px/s = 18px, with no carried remainder
    expect(moves).toEqual([18]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd userscript && npm test`
Expected: FAIL — cannot resolve `../src/scroll.js`.

- [ ] **Step 4: Write the implementation**

`userscript/src/scroll.js`:

```javascript
/** Frame-rate independent auto-scrolling. */

// A backgrounded tab can produce a delta of many seconds. Cap it so the page
// does not lurch when it comes back into view.
export const MAX_FRAME_SECONDS = 0.1;

export function clampSpeed(speed, min, max) {
  if (Number.isNaN(speed)) return min;
  return Math.min(max, Math.max(min, speed));
}

export class ScrollEngine {
  constructor({
    scrollBy,
    requestFrame,
    cancelFrame,
    speed,
    min,
    max,
    step,
  }) {
    this._scrollBy = scrollBy;
    this._requestFrame = requestFrame;
    this._cancelFrame = cancelFrame;
    this._min = min;
    this._max = max;
    this._step = step;
    this._speed = clampSpeed(speed, min, max);
    this._running = false;
    this._frame = null;
    this._lastTimestamp = null;
    this._remainder = 0;
  }

  get running() {
    return this._running;
  }

  get speed() {
    return this._speed;
  }

  get step() {
    return this._step;
  }

  setSpeed(pxPerSecond) {
    this._speed = clampSpeed(pxPerSecond, this._min, this._max);
    this._remainder = 0;
    return this._speed;
  }

  adjustSpeed(delta) {
    return this.setSpeed(this._speed + delta);
  }

  /** Adopt limits reported by the daemon, re-clamping the current speed. */
  setLimits(min, max) {
    this._min = min;
    this._max = max;
    return this.setSpeed(this._speed);
  }

  start() {
    if (this._running) return true;
    this._running = true;
    this._lastTimestamp = null;
    this._remainder = 0;
    this._frame = this._requestFrame((t) => this.tick(t));
    return true;
  }

  stop() {
    if (!this._running) return false;
    this._running = false;
    if (this._frame !== null) this._cancelFrame(this._frame);
    this._frame = null;
    this._lastTimestamp = null;
    return false;
  }

  toggle() {
    return this._running ? this.stop() : this.start();
  }

  tick(timestampMs) {
    if (!this._running) return;

    if (this._lastTimestamp !== null) {
      const dt = Math.min(
        MAX_FRAME_SECONDS,
        (timestampMs - this._lastTimestamp) / 1000,
      );
      this._remainder += this._speed * dt;
      const whole = Math.trunc(this._remainder);
      if (whole !== 0) {
        this._remainder -= whole;
        this._scrollBy(whole);
      }
    }

    this._lastTimestamp = timestampMs;
    this._frame = this._requestFrame((t) => this.tick(t));
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd userscript && npm test`
Expected: PASS, 15 tests.

- [ ] **Step 6: Commit**

```bash
git add userscript/package.json userscript/package-lock.json userscript/build.mjs userscript/vitest.config.js userscript/src userscript/tests
git commit -m "feat: add the userscript toolchain and scroll engine"
```

---

### Task 8: Post selection

**Files:**
- Create: `userscript/src/selection.js`
- Test: `userscript/tests/selection.test.js`
- Test: `userscript/tests/selection.dom.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `HIGHLIGHT_CLASS = "rs-selected"`
  - `rankPosts(rects: {top: number, bottom: number}[], focusY: number, viewportHeight: number) -> number` — index of the post whose top edge is nearest the focus line among those intersecting the viewport, or `-1`.
  - `readPosts(root: Document|Element) -> {element, permalink, title, subreddit, score}[]`
  - `class Selection`:
    - `constructor({ root, getViewportHeight, focusLine })`
    - `refresh() -> void` — re-reads the DOM and recomputes the selected index from the focus line.
    - `selected` (getter) — `{permalink, title, subreddit, score} | null`
    - `selectedElement` (getter) — `Element | null`
    - `count` (getter) — number of posts found
    - `move(delta: number) -> Element | null` — moves selection by `delta` posts, clamped, and returns the new element.
    - `applyHighlight() -> void` — puts `HIGHLIGHT_CLASS` on the selected element and removes it from all others.
    - `setFocusLine(fraction: number) -> void` — adopts the daemon's configured focus line, for the same reason `ScrollEngine.setLimits` exists.
    - `focusLine` (getter)

New Reddit's feed posts are `<shreddit-post>` custom elements whose attributes carry everything needed, so nothing here touches shadow DOM.

- [ ] **Step 1: Write the failing pure-logic tests**

`userscript/tests/selection.test.js`:

```javascript
import { describe, expect, it } from "vitest";
import { rankPosts } from "../src/selection.js";

const VIEWPORT = 1000;
const FOCUS_Y = 250;

describe("rankPosts", () => {
  it("returns -1 for an empty list", () => {
    expect(rankPosts([], FOCUS_Y, VIEWPORT)).toBe(-1);
  });

  it("picks the post whose top edge is nearest the focus line", () => {
    const rects = [
      { top: 10, bottom: 200 },
      { top: 210, bottom: 400 },
      { top: 600, bottom: 900 },
    ];
    expect(rankPosts(rects, FOCUS_Y, VIEWPORT)).toBe(1);
  });

  it("can pick a post whose top edge is above the focus line", () => {
    const rects = [
      { top: 240, bottom: 700 },
      { top: 720, bottom: 900 },
    ];
    expect(rankPosts(rects, FOCUS_Y, VIEWPORT)).toBe(0);
  });

  it("considers a post scrolled partly off the top if it still intersects", () => {
    const rects = [
      { top: -100, bottom: 300 },
      { top: 800, bottom: 1200 },
    ];
    expect(rankPosts(rects, FOCUS_Y, VIEWPORT)).toBe(0);
  });

  it("ignores posts entirely above the viewport", () => {
    const rects = [
      { top: -900, bottom: -400 },
      { top: 600, bottom: 800 },
    ];
    expect(rankPosts(rects, FOCUS_Y, VIEWPORT)).toBe(1);
  });

  it("ignores posts entirely below the viewport", () => {
    const rects = [
      { top: 400, bottom: 700 },
      { top: 1200, bottom: 1600 },
    ];
    expect(rankPosts(rects, FOCUS_Y, VIEWPORT)).toBe(0);
  });

  it("returns -1 when nothing intersects the viewport", () => {
    const rects = [
      { top: -900, bottom: -400 },
      { top: 1200, bottom: 1600 },
    ];
    expect(rankPosts(rects, FOCUS_Y, VIEWPORT)).toBe(-1);
  });

  it("breaks ties toward the earlier post", () => {
    const rects = [
      { top: 200, bottom: 400 },
      { top: 300, bottom: 500 },
    ];
    expect(rankPosts(rects, FOCUS_Y, VIEWPORT)).toBe(0);
  });
});
```

- [ ] **Step 2: Write the failing DOM tests**

`userscript/tests/selection.dom.test.js`:

```javascript
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { HIGHLIGHT_CLASS, Selection, readPosts } from "../src/selection.js";

const POSTS = [
  { permalink: "/r/a/comments/1/one/", title: "One", sub: "r/a", score: "12" },
  { permalink: "/r/b/comments/2/two/", title: "Two", sub: "r/b", score: "34" },
  { permalink: "/r/c/comments/3/three/", title: "Three", sub: "r/c", score: "56" },
];

function buildFeed(posts = POSTS) {
  document.body.innerHTML = posts
    .map(
      (p) =>
        `<shreddit-post permalink="${p.permalink}" post-title="${p.title}" ` +
        `subreddit-prefixed-name="${p.sub}" score="${p.score}"></shreddit-post>`,
    )
    .join("");
  // jsdom has no layout, so stub the rects: 200px tall, stacked from y=0.
  document.querySelectorAll("shreddit-post").forEach((el, i) => {
    el.getBoundingClientRect = () => ({
      top: i * 200,
      bottom: i * 200 + 200,
      left: 0,
      right: 500,
      width: 500,
      height: 200,
    });
    el.scrollIntoView = () => {};
  });
}

function makeSelection() {
  return new Selection({
    root: document,
    getViewportHeight: () => 1000,
    focusLine: 0.25,
  });
}

beforeEach(() => buildFeed());

describe("readPosts", () => {
  it("reads every post's attributes", () => {
    const found = readPosts(document);
    expect(found).toHaveLength(3);
    expect(found[1]).toMatchObject({
      permalink: "/r/b/comments/2/two/",
      title: "Two",
      subreddit: "r/b",
      score: 34,
    });
  });

  it("returns an empty list when the feed has no posts", () => {
    document.body.innerHTML = "<div>nothing here</div>";
    expect(readPosts(document)).toEqual([]);
  });

  it("skips posts with no permalink, which cannot be opened", () => {
    document.body.innerHTML =
      '<shreddit-post post-title="Broken"></shreddit-post>';
    expect(readPosts(document)).toEqual([]);
  });

  it("treats a missing score as zero", () => {
    document.body.innerHTML =
      '<shreddit-post permalink="/r/a/comments/1/x/" post-title="X"></shreddit-post>';
    expect(readPosts(document)[0].score).toBe(0);
  });
});

describe("Selection", () => {
  it("selects the post nearest the focus line", () => {
    const sel = makeSelection();
    sel.refresh();
    // Focus line is 250; tops are 0, 200, 400 — 200 is nearest.
    expect(sel.selected.title).toBe("Two");
    expect(sel.count).toBe(3);
  });

  it("reports null when there are no posts", () => {
    document.body.innerHTML = "";
    const sel = makeSelection();
    sel.refresh();
    expect(sel.selected).toBeNull();
    expect(sel.selectedElement).toBeNull();
    expect(sel.count).toBe(0);
  });

  it("moves selection forward and backward", () => {
    const sel = makeSelection();
    sel.refresh();
    sel.move(1);
    expect(sel.selected.title).toBe("Three");
    sel.move(-1);
    expect(sel.selected.title).toBe("Two");
  });

  it("clamps movement at both ends", () => {
    const sel = makeSelection();
    sel.refresh();
    sel.move(-5);
    expect(sel.selected.title).toBe("One");
    sel.move(99);
    expect(sel.selected.title).toBe("Three");
  });

  it("returns null from move when there are no posts", () => {
    document.body.innerHTML = "";
    const sel = makeSelection();
    sel.refresh();
    expect(sel.move(1)).toBeNull();
  });

  it("highlights exactly one post", () => {
    const sel = makeSelection();
    sel.refresh();
    sel.applyHighlight();
    const marked = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
    expect(marked).toHaveLength(1);
    expect(marked[0].getAttribute("post-title")).toBe("Two");
  });

  it("moves the highlight rather than adding a second one", () => {
    const sel = makeSelection();
    sel.refresh();
    sel.applyHighlight();
    sel.move(1);
    sel.applyHighlight();
    const marked = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
    expect(marked).toHaveLength(1);
    expect(marked[0].getAttribute("post-title")).toBe("Three");
  });

  it("selects a different post once the focus line moves", () => {
    const sel = makeSelection();
    sel.refresh();
    expect(sel.selected.title).toBe("Two"); // focus line 250, tops 0/200/400
    sel.setFocusLine(0.45); // focus line 450, so top 400 wins
    sel.refresh();
    expect(sel.selected.title).toBe("Three");
  });

  it("keeps the manually chosen post selected across a refresh", () => {
    const sel = makeSelection();
    sel.refresh();
    sel.move(1); // "Three", away from the focus line
    sel.refresh();
    expect(sel.selected.title).toBe("Three");
  });

  it("follows the focus line again once the pinned post scrolls away", () => {
    const sel = makeSelection();
    sel.refresh();
    sel.move(1); // pin "Three"
    document.querySelectorAll("shreddit-post").forEach((el, i) => {
      el.getBoundingClientRect = () => ({
        top: i * 200 - 3000,
        bottom: i * 200 - 2800,
        left: 0,
        right: 500,
        width: 500,
        height: 200,
      });
    });
    sel.refresh();
    expect(sel.selected).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd userscript && npm test`
Expected: FAIL — cannot resolve `../src/selection.js`.

- [ ] **Step 4: Write the implementation**

`userscript/src/selection.js`:

```javascript
/** Reading Reddit's feed posts and tracking which one is "current". */

export const HIGHLIGHT_CLASS = "rs-selected";
const POST_SELECTOR = "shreddit-post";

/**
 * Index of the post whose top edge sits nearest the focus line, among those
 * intersecting the viewport. Returns -1 when nothing qualifies.
 */
export function rankPosts(rects, focusY, viewportHeight) {
  let best = -1;
  let bestDistance = Infinity;
  rects.forEach((rect, index) => {
    if (rect.bottom <= 0 || rect.top >= viewportHeight) return;
    const distance = Math.abs(rect.top - focusY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Read every usable post out of the feed. */
export function readPosts(root) {
  return Array.from(root.querySelectorAll(POST_SELECTOR))
    .filter((element) => element.getAttribute("permalink"))
    .map((element) => ({
      element,
      permalink: element.getAttribute("permalink"),
      title: element.getAttribute("post-title") || "",
      subreddit: element.getAttribute("subreddit-prefixed-name") || "",
      score: Number(element.getAttribute("score") || 0),
    }));
}

export class Selection {
  constructor({ root, getViewportHeight, focusLine }) {
    this._root = root;
    this._getViewportHeight = getViewportHeight;
    this._focusLine = focusLine;
    this._posts = [];
    this._index = -1;
    // A permalink the user chose explicitly with prev/next. While it is still
    // on screen it wins over the focus line, so a deliberate choice is not
    // yanked away by the next scroll frame.
    this._pinned = null;
  }

  get count() {
    return this._posts.length;
  }

  get focusLine() {
    return this._focusLine;
  }

  setFocusLine(fraction) {
    this._focusLine = fraction;
  }

  get selectedElement() {
    const post = this._posts[this._index];
    return post ? post.element : null;
  }

  get selected() {
    const post = this._posts[this._index];
    if (!post) return null;
    const { permalink, title, subreddit, score } = post;
    return { permalink, title, subreddit, score };
  }

  refresh() {
    this._posts = readPosts(this._root);
    if (this._posts.length === 0) {
      this._index = -1;
      return;
    }

    const viewportHeight = this._getViewportHeight();
    const rects = this._posts.map((post) =>
      post.element.getBoundingClientRect(),
    );

    if (this._pinned !== null) {
      const pinnedIndex = this._posts.findIndex(
        (post) => post.permalink === this._pinned,
      );
      const rect = rects[pinnedIndex];
      const stillVisible =
        rect && rect.bottom > 0 && rect.top < viewportHeight;
      if (stillVisible) {
        this._index = pinnedIndex;
        return;
      }
      this._pinned = null;
    }

    this._index = rankPosts(
      rects,
      viewportHeight * this._focusLine,
      viewportHeight,
    );
  }

  move(delta) {
    if (this._posts.length === 0) return null;
    const from = this._index === -1 ? 0 : this._index;
    this._index = Math.min(
      this._posts.length - 1,
      Math.max(0, from + delta),
    );
    this._pinned = this._posts[this._index].permalink;
    return this.selectedElement;
  }

  applyHighlight() {
    const wanted = this.selectedElement;
    this._root
      .querySelectorAll(`.${HIGHLIGHT_CLASS}`)
      .forEach((element) => {
        if (element !== wanted) element.classList.remove(HIGHLIGHT_CLASS);
      });
    if (wanted) wanted.classList.add(HIGHLIGHT_CLASS);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd userscript && npm test`
Expected: PASS, 21 new tests plus the 15 from Task 7.

- [ ] **Step 6: Commit**

```bash
git add userscript/src/selection.js userscript/tests/selection.test.js userscript/tests/selection.dom.test.js
git commit -m "feat: add post reading and focus-line selection"
```

---

### Task 9: The HUD overlay

**Files:**
- Create: `userscript/src/hud.js`
- Test: `userscript/tests/hud.test.js`
- Test: `userscript/tests/hud.dom.test.js`

**Interfaces:**
- Consumes: `HIGHLIGHT_CLASS` (Task 8).
- Produces:
  - `HUD_ID = "rs-hud"`
  - `BAR_CELLS = 12`
  - `formatHud(state) -> { status, statusClass, speed, bar, mode, subreddit, title, daemon, daemonClass, flash }`
  - `class Hud`: `constructor(doc)`, `mount()`, `render(state)`, `unmount()`

The HUD is a pure view — it holds no state and decides nothing. The transient "last
command" flash is timed by `main.js` (Task 11) and arrives as just another field on the
state object.

The HUD state object, produced by `main.js` in Task 11:

```javascript
{
  running: boolean,
  speed: number,
  speedMin: number,
  speedMax: number,
  mode: "feed" | "thread",
  selected: { title, subreddit, score } | null,
  postCount: number,
  daemonConnected: boolean,
  lastCommand: string | null,
}
```

- [ ] **Step 1: Write the failing formatting tests**

`userscript/tests/hud.test.js`:

```javascript
import { describe, expect, it } from "vitest";
import { BAR_CELLS, formatHud } from "../src/hud.js";

const BASE = {
  running: true,
  speed: 90,
  speedMin: 15,
  speedMax: 600,
  mode: "feed",
  selected: { title: "Is 64GB overkill?", subreddit: "r/buildapc", score: 412 },
  postCount: 25,
  daemonConnected: true,
  lastCommand: null,
};

describe("formatHud", () => {
  it("shows the running state", () => {
    const out = formatHud(BASE);
    expect(out.status).toBe("SCROLLING");
    expect(out.statusClass).toBe("rs-running");
  });

  it("shows the paused state", () => {
    const out = formatHud({ ...BASE, running: false });
    expect(out.status).toBe("PAUSED");
    expect(out.statusClass).toBe("rs-paused");
  });

  it("renders the speed with units", () => {
    expect(formatHud(BASE).speed).toBe("90 px/s");
  });

  it("rounds a fractional speed", () => {
    expect(formatHud({ ...BASE, speed: 97.4 }).speed).toBe("97 px/s");
  });

  it("renders a bar of fixed width", () => {
    expect(formatHud(BASE).bar).toHaveLength(BAR_CELLS);
  });

  it("renders an almost-empty bar at the minimum speed", () => {
    expect(formatHud({ ...BASE, speed: 15 }).bar).toBe("░".repeat(BAR_CELLS));
  });

  it("renders a full bar at the maximum speed", () => {
    expect(formatHud({ ...BASE, speed: 600 }).bar).toBe("▓".repeat(BAR_CELLS));
  });

  it("uppercases the mode", () => {
    expect(formatHud(BASE).mode).toBe("FEED");
    expect(formatHud({ ...BASE, mode: "thread" }).mode).toBe("THREAD");
  });

  it("quotes the selected post's title", () => {
    const out = formatHud(BASE);
    expect(out.subreddit).toBe("r/buildapc");
    expect(out.title).toBe("“Is 64GB overkill?”");
  });

  it("says so when no post is selected but the feed has posts", () => {
    const out = formatHud({ ...BASE, selected: null });
    expect(out.title).toBe("no post in focus");
    expect(out.subreddit).toBe("");
  });

  it("says so when the feed has no posts at all", () => {
    const out = formatHud({ ...BASE, selected: null, postCount: 0 });
    expect(out.title).toBe("no posts detected");
  });

  it("hides post details in thread mode", () => {
    const out = formatHud({ ...BASE, mode: "thread" });
    expect(out.title).toBe("");
    expect(out.subreddit).toBe("");
  });

  it("reports the daemon connection", () => {
    expect(formatHud(BASE).daemon).toBe("daemon");
    expect(formatHud(BASE).daemonClass).toBe("rs-online");
    const off = formatHud({ ...BASE, daemonConnected: false });
    expect(off.daemon).toBe("no daemon");
    expect(off.daemonClass).toBe("rs-offline");
  });

  it("shows the last command, uppercased", () => {
    expect(formatHud({ ...BASE, lastCommand: "faster" }).flash).toBe("FASTER");
    expect(formatHud(BASE).flash).toBe("");
  });
});
```

- [ ] **Step 2: Write the failing DOM tests**

`userscript/tests/hud.dom.test.js`:

```javascript
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { HUD_ID, Hud } from "../src/hud.js";

const STATE = {
  running: false,
  speed: 90,
  speedMin: 15,
  speedMax: 600,
  mode: "feed",
  selected: { title: "Hello", subreddit: "r/test", score: 1 },
  postCount: 3,
  daemonConnected: false,
  lastCommand: null,
};

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("Hud", () => {
  it("mounts one panel and its stylesheet", () => {
    new Hud(document).mount();
    expect(document.querySelectorAll(`#${HUD_ID}`)).toHaveLength(1);
    expect(document.querySelectorAll("style#rs-style")).toHaveLength(1);
  });

  it("mounting twice does not produce two panels", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.mount();
    expect(document.querySelectorAll(`#${HUD_ID}`)).toHaveLength(1);
  });

  it("a second instance adopts an existing panel and can still render it", () => {
    new Hud(document).mount();
    const second = new Hud(document);
    second.mount();
    second.render(STATE);
    expect(document.querySelectorAll(`#${HUD_ID}`)).toHaveLength(1);
    expect(document.querySelector(`#${HUD_ID}`).textContent).toContain("90 px/s");
  });

  it("writes the state into the panel", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.render(STATE);
    const text = document.querySelector(`#${HUD_ID}`).textContent;
    expect(text).toContain("PAUSED");
    expect(text).toContain("90 px/s");
    expect(text).toContain("FEED");
    expect(text).toContain("r/test");
    expect(text).toContain("no daemon");
  });

  it("renders titles as text, never as markup", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.render({
      ...STATE,
      selected: { title: "<img src=x onerror=alert(1)>", subreddit: "r/x", score: 0 },
    });
    expect(document.querySelector(`#${HUD_ID}`).querySelector("img")).toBeNull();
  });

  it("rendering before mount is harmless", () => {
    expect(() => new Hud(document).render(STATE)).not.toThrow();
  });

  it("unmount removes the panel", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.unmount();
    expect(document.querySelector(`#${HUD_ID}`)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd userscript && npm test`
Expected: FAIL — cannot resolve `../src/hud.js`.

- [ ] **Step 4: Write the implementation**

`userscript/src/hud.js`:

```javascript
/** The on-screen readout, sized to be legible from another monitor. */

import { HIGHLIGHT_CLASS } from "./selection.js";

export const HUD_ID = "rs-hud";
export const BAR_CELLS = 12;

const STYLE_ID = "rs-style";

const CSS = `
#${HUD_ID} {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483647;
  width: 320px;
  padding: 14px 16px;
  border-radius: 10px;
  background: rgba(16, 16, 20, 0.92);
  color: #f2f2f2;
  font: 500 17px/1.35 "Segoe UI", system-ui, sans-serif;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  user-select: none;
}
#${HUD_ID} .rs-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}
#${HUD_ID} .rs-status { font-weight: 700; letter-spacing: 0.04em; }
#${HUD_ID} .rs-running { color: #56d364; }
#${HUD_ID} .rs-paused { color: #e3b341; }
#${HUD_ID} .rs-online { color: #56d364; font-size: 14px; }
#${HUD_ID} .rs-offline { color: #f85149; font-size: 14px; }
#${HUD_ID} .rs-rule {
  height: 1px;
  margin: 9px 0;
  background: rgba(255, 255, 255, 0.16);
}
#${HUD_ID} .rs-bar {
  font-family: "Cascadia Mono", Consolas, monospace;
  letter-spacing: 1px;
  color: #58a6ff;
}
#${HUD_ID} .rs-mode { font-size: 14px; opacity: 0.65; letter-spacing: 0.08em; }
#${HUD_ID} .rs-sub { font-size: 14px; opacity: 0.75; }
#${HUD_ID} .rs-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
#${HUD_ID} .rs-flash { font-size: 14px; color: #58a6ff; min-height: 19px; }
.${HIGHLIGHT_CLASS} {
  outline: 3px solid #58a6ff !important;
  outline-offset: 2px;
  border-radius: 8px;
}
`;

export function formatHud(state) {
  const span = Math.max(1, state.speedMax - state.speedMin);
  const filled = Math.round(
    ((state.speed - state.speedMin) / span) * BAR_CELLS,
  );
  const clamped = Math.min(BAR_CELLS, Math.max(0, filled));

  let subreddit = "";
  let title = "";
  if (state.mode === "feed") {
    if (state.selected) {
      subreddit = state.selected.subreddit;
      title = `“${state.selected.title}”`;
    } else {
      title = state.postCount === 0 ? "no posts detected" : "no post in focus";
    }
  }

  return {
    status: state.running ? "SCROLLING" : "PAUSED",
    statusClass: state.running ? "rs-running" : "rs-paused",
    speed: `${Math.round(state.speed)} px/s`,
    bar: "▓".repeat(clamped) + "░".repeat(BAR_CELLS - clamped),
    mode: state.mode.toUpperCase(),
    subreddit,
    title,
    daemon: state.daemonConnected ? "daemon" : "no daemon",
    daemonClass: state.daemonConnected ? "rs-online" : "rs-offline",
    flash: state.lastCommand ? state.lastCommand.toUpperCase() : "",
  };
}

export class Hud {
  constructor(doc) {
    this._doc = doc;
    this._root = null;
    this._nodes = null;
  }

  mount() {
    const existing = this._doc.getElementById(HUD_ID);
    if (existing) {
      // Adopt a panel a previous instance left behind, so render() still works.
      this._root = existing;
      this._nodes = this._collect(existing);
      return;
    }

    if (!this._doc.getElementById(STYLE_ID)) {
      const style = this._doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      this._doc.head.appendChild(style);
    }

    const root = this._doc.createElement("div");
    root.id = HUD_ID;
    root.innerHTML = `
      <div class="rs-row">
        <span class="rs-status"></span>
        <span class="rs-daemon"></span>
      </div>
      <div class="rs-rule"></div>
      <div class="rs-row">
        <span class="rs-speed"></span>
        <span class="rs-bar"></span>
      </div>
      <div class="rs-mode"></div>
      <div class="rs-sub"></div>
      <div class="rs-title"></div>
      <div class="rs-flash"></div>
    `;
    this._doc.body.appendChild(root);
    this._root = root;
    this._nodes = this._collect(root);
  }

  _collect(root) {
    return {
      status: root.querySelector(".rs-status"),
      daemon: root.querySelector(".rs-daemon"),
      speed: root.querySelector(".rs-speed"),
      bar: root.querySelector(".rs-bar"),
      mode: root.querySelector(".rs-mode"),
      sub: root.querySelector(".rs-sub"),
      title: root.querySelector(".rs-title"),
      flash: root.querySelector(".rs-flash"),
    };
  }

  render(state) {
    if (!this._nodes) return;
    const view = formatHud(state);
    const n = this._nodes;
    n.status.textContent = view.status;
    n.status.className = `rs-status ${view.statusClass}`;
    n.daemon.textContent = `● ${view.daemon}`;
    n.daemon.className = view.daemonClass;
    n.speed.textContent = view.speed;
    n.bar.textContent = view.bar;
    n.mode.textContent = view.mode;
    n.sub.textContent = view.subreddit;
    n.title.textContent = view.title;
    n.flash.textContent = view.flash;
  }

  unmount() {
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
    this._root = null;
    this._nodes = null;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd userscript && npm test`
Expected: PASS, 21 new tests.

Note the `renders titles as text, never as markup` test: every field goes in through `textContent`, so a post title containing HTML cannot inject anything.

- [ ] **Step 6: Commit**

```bash
git add userscript/src/hud.js userscript/tests/hud.test.js userscript/tests/hud.dom.test.js
git commit -m "feat: add the on-page HUD overlay"
```

---

### Task 10: The long-poll transport

**Files:**
- Create: `userscript/src/transport.js`
- Test: `userscript/tests/transport.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `nextBackoff(current: number) -> number` — `1000` from `0`, otherwise `min(current * 2, 5000)`.
  - `class Transport`:
    - `constructor({ port, request, sleep, onCommands, onConnectionChange })` where `request({method, url, body}) -> Promise<{status, text}>` and `sleep(ms) -> Promise<void>`.
    - `start() -> Promise<void>` — runs the poll loop until `stop()`.
    - `stop() -> void`
    - `postState(state: object) -> Promise<void>` — fire-and-forget; never throws.
    - `settings` (getter) — the `settings` object from `/health`, or `null`.
    - `connected` (getter)
  - `gmRequest(options) -> Promise<{status, text}>` — the real `GM_xmlhttpRequest` adapter.

- [ ] **Step 1: Write the failing tests**

`userscript/tests/transport.test.js`:

```javascript
import { describe, expect, it, vi } from "vitest";
import { Transport, nextBackoff } from "../src/transport.js";

function harness({ responses }) {
  const calls = [];
  const sleeps = [];
  let index = 0;

  const request = vi.fn(async (options) => {
    calls.push(options);
    const responder = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (typeof responder === "function") return responder(options);
    return responder;
  });

  const commands = [];
  const connection = [];
  const transport = new Transport({
    port: 8765,
    request,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onCommands: (list) => commands.push(...list),
    onConnectionChange: (ok) => connection.push(ok),
  });

  return { transport, request, calls, sleeps, commands, connection };
}

const ok = (body) => ({ status: 200, text: JSON.stringify(body) });

describe("nextBackoff", () => {
  it("starts at one second", () => {
    expect(nextBackoff(0)).toBe(1000);
  });

  it("doubles", () => {
    expect(nextBackoff(1000)).toBe(2000);
  });

  it("caps at five seconds", () => {
    expect(nextBackoff(4000)).toBe(5000);
    expect(nextBackoff(5000)).toBe(5000);
  });
});

describe("Transport", () => {
  it("fetches settings from /health before polling", async () => {
    const h = harness({
      responses: [
        ok({ ok: true, settings: { default_speed: 90 } }),
        (o) => {
          h.transport.stop();
          return ok({ cursor: 0, events: [] });
        },
      ],
    });
    await h.transport.start();
    expect(h.calls[0].url).toBe("http://127.0.0.1:8765/health");
    expect(h.transport.settings).toEqual({ default_speed: 90 });
  });

  it("delivers commands from a poll", async () => {
    const h = harness({
      responses: [
        ok({ ok: true, settings: {} }),
        (o) => {
          h.transport.stop();
          return ok({
            cursor: 2,
            events: [
              { seq: 1, command: "toggle" },
              { seq: 2, command: "faster" },
            ],
          });
        },
      ],
    });
    await h.transport.start();
    expect(h.commands).toEqual(["toggle", "faster"]);
  });

  it("advances the cursor between polls", async () => {
    const h = harness({
      responses: [
        ok({ ok: true, settings: {} }),
        ok({ cursor: 7, events: [{ seq: 7, command: "next" }] }),
        (o) => {
          h.transport.stop();
          return ok({ cursor: 7, events: [] });
        },
      ],
    });
    await h.transport.start();
    expect(h.calls[1].url).toContain("cursor=0");
    expect(h.calls[2].url).toContain("cursor=7");
  });

  it("reports the connection as up after a good poll", async () => {
    const h = harness({
      responses: [
        ok({ ok: true, settings: {} }),
        (o) => {
          h.transport.stop();
          return ok({ cursor: 0, events: [] });
        },
      ],
    });
    await h.transport.start();
    expect(h.connection.at(-1)).toBe(true);
    expect(h.transport.connected).toBe(true);
  });

  it("reports the connection as down and backs off after a failure", async () => {
    let attempts = 0;
    const h = harness({
      responses: [
        () => {
          attempts += 1;
          if (attempts >= 3) h.transport.stop();
          throw new Error("connection refused");
        },
      ],
    });
    await h.transport.start();
    expect(h.connection[0]).toBe(false);
    expect(h.transport.connected).toBe(false);
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it("treats a non-200 response as a failure", async () => {
    let attempts = 0;
    const h = harness({
      responses: [
        () => {
          attempts += 1;
          if (attempts >= 2) h.transport.stop();
          return { status: 500, text: "boom" };
        },
      ],
    });
    await h.transport.start();
    expect(h.connection[0]).toBe(false);
  });

  it("treats an unparseable body as a failure", async () => {
    let attempts = 0;
    const h = harness({
      responses: [
        () => {
          attempts += 1;
          if (attempts >= 2) h.transport.stop();
          return { status: 200, text: "{not json" };
        },
      ],
    });
    await h.transport.start();
    expect(h.connection[0]).toBe(false);
  });

  it("resets the backoff after recovering", async () => {
    let calls = 0;
    const h = harness({
      responses: [
        () => {
          calls += 1;
          if (calls === 1) throw new Error("down");
          if (calls === 2) return ok({ ok: true, settings: {} });
          if (calls === 3) return ok({ cursor: 0, events: [] });
          if (calls === 4) throw new Error("down again");
          h.transport.stop();
          return ok({ ok: true, settings: {} });
        },
      ],
    });
    await h.transport.start();
    expect(h.sleeps).toEqual([1000, 1000]);
  });

  it("only reports a connection change when it actually changes", async () => {
    const h = harness({
      responses: [
        ok({ ok: true, settings: {} }),
        ok({ cursor: 0, events: [] }),
        ok({ cursor: 0, events: [] }),
        (o) => {
          h.transport.stop();
          return ok({ cursor: 0, events: [] });
        },
      ],
    });
    await h.transport.start();
    expect(h.connection).toEqual([true]);
  });

  it("posts state as JSON", async () => {
    const h = harness({ responses: [ok({ ok: true })] });
    await h.transport.postState({ running: true, speed: 90 });
    expect(h.calls[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:8765/state",
      body: JSON.stringify({ running: true, speed: 90 }),
    });
  });

  it("swallows errors from posting state", async () => {
    const h = harness({
      responses: [
        () => {
          throw new Error("down");
        },
      ],
    });
    await expect(h.transport.postState({ running: true })).resolves.toBeUndefined();
  });

  it("stops polling once stopped", async () => {
    const h = harness({
      responses: [
        ok({ ok: true, settings: {} }),
        (o) => {
          h.transport.stop();
          return ok({ cursor: 0, events: [] });
        },
      ],
    });
    await h.transport.start();
    const after = h.request.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.request.mock.calls.length).toBe(after);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd userscript && npm test`
Expected: FAIL — cannot resolve `../src/transport.js`.

- [ ] **Step 3: Write the implementation**

`userscript/src/transport.js`:

```javascript
/**
 * Long-poll transport to the local daemon.
 *
 * A WebSocket would be the obvious choice, but ws:// from an https:// page is
 * mixed content and userscript managers do not proxy sockets. GM_xmlhttpRequest
 * runs in the manager's privileged context, so a held GET is both allowed and
 * fast enough to be indistinguishable from a socket here.
 */

const MAX_BACKOFF_MS = 5000;

export function nextBackoff(current) {
  if (!current) return 1000;
  return Math.min(current * 2, MAX_BACKOFF_MS);
}

/** Adapter turning GM_xmlhttpRequest's callback API into a promise. */
export function gmRequest({ method, url, body }) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method,
      url,
      data: body,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      timeout: 40000,
      onload: (r) => resolve({ status: r.status, text: r.responseText }),
      onerror: () => reject(new Error(`request to ${url} failed`)),
      ontimeout: () => reject(new Error(`request to ${url} timed out`)),
    });
  });
}

export class Transport {
  constructor({ port, request, sleep, onCommands, onConnectionChange }) {
    this._base = `http://127.0.0.1:${port}`;
    this._request = request;
    this._sleep = sleep;
    this._onCommands = onCommands;
    this._onConnectionChange = onConnectionChange;
    this._cursor = 0;
    this._backoff = 0;
    this._running = false;
    this._connected = false;
    this._settings = null;
  }

  get connected() {
    return this._connected;
  }

  get settings() {
    return this._settings;
  }

  stop() {
    this._running = false;
  }

  async start() {
    this._running = true;
    while (this._running) {
      try {
        if (this._settings === null) {
          const health = await this._json("GET", "/health");
          this._settings = health.settings || {};
        }
        const body = await this._json("GET", `/events?cursor=${this._cursor}`);
        this._setConnected(true);
        this._backoff = 0;
        if (typeof body.cursor === "number") this._cursor = body.cursor;
        const commands = (body.events || []).map((event) => event.command);
        if (commands.length) this._onCommands(commands);
      } catch {
        this._setConnected(false);
        if (!this._running) break;
        this._backoff = nextBackoff(this._backoff);
        await this._sleep(this._backoff);
      }
    }
  }

  async postState(state) {
    try {
      await this._request({
        method: "POST",
        url: `${this._base}/state`,
        body: JSON.stringify(state),
      });
    } catch {
      // The daemon being down is normal and already shown in the HUD.
    }
  }

  async _json(method, path) {
    const response = await this._request({
      method,
      url: `${this._base}${path}`,
    });
    if (response.status !== 200) {
      throw new Error(`${path} returned ${response.status}`);
    }
    return JSON.parse(response.text);
  }

  _setConnected(value) {
    if (this._connected === value) return;
    this._connected = value;
    this._onConnectionChange(value);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd userscript && npm test`
Expected: PASS, 15 new tests.

- [ ] **Step 5: Commit**

```bash
git add userscript/src/transport.js userscript/tests/transport.test.js
git commit -m "feat: add the long-poll transport to the daemon"
```

---

### Task 11: Command routing and the assembled userscript

**Files:**
- Modify: `userscript/src/main.js` (replaces the Task 7 placeholder)
- Create: `userscript/src/commands.js`
- Test: `userscript/tests/commands.test.js`

**Interfaces:**
- Consumes: `ScrollEngine`, `clampSpeed` (Task 7); `Selection` (Task 8); `Hud` (Task 9); `Transport`, `gmRequest` (Task 10).
- Produces from `commands.js`:
  - `detectMode(pathname: string) -> "feed" | "thread"`
  - `resolveAction(command: string, mode: string) -> string` — one of `toggleScroll`, `speedUp`, `speedDown`, `openSelected`, `goBack`, `selectNext`, `selectPrev`, `pageDown`, `pageUp`, `noop`.
  - `commandForKeyCode(code: string) -> string | null` — maps a `KeyboardEvent.code` to a command, for the in-page fallback when Firefox has focus.

Splitting the routing table out of `main.js` keeps every decision testable without a browser; `main.js` is left as wiring only.

- [ ] **Step 1: Write the failing tests**

`userscript/tests/commands.test.js`:

```javascript
import { describe, expect, it } from "vitest";
import { commandForKeyCode, detectMode, resolveAction } from "../src/commands.js";

describe("detectMode", () => {
  it("calls a comments URL a thread", () => {
    expect(detectMode("/r/buildapc/comments/1abc/is_64gb_overkill/")).toBe(
      "thread",
    );
  });

  it("calls the front page a feed", () => {
    expect(detectMode("/")).toBe("feed");
  });

  it("calls a subreddit listing a feed", () => {
    expect(detectMode("/r/buildapc/")).toBe("feed");
  });

  it("calls a sorted listing a feed", () => {
    expect(detectMode("/r/buildapc/top/?t=week")).toBe("feed");
  });
});

describe("resolveAction", () => {
  it("toggles scrolling in either mode", () => {
    expect(resolveAction("toggle", "feed")).toBe("toggleScroll");
    expect(resolveAction("toggle", "thread")).toBe("toggleScroll");
  });

  it("changes speed in either mode", () => {
    expect(resolveAction("faster", "feed")).toBe("speedUp");
    expect(resolveAction("slower", "thread")).toBe("speedDown");
  });

  it("opens the selected post only in the feed", () => {
    expect(resolveAction("open", "feed")).toBe("openSelected");
    expect(resolveAction("open", "thread")).toBe("noop");
  });

  it("goes back only from a thread", () => {
    expect(resolveAction("back", "thread")).toBe("goBack");
    expect(resolveAction("back", "feed")).toBe("noop");
  });

  it("moves selection in the feed", () => {
    expect(resolveAction("next", "feed")).toBe("selectNext");
    expect(resolveAction("prev", "feed")).toBe("selectPrev");
  });

  it("pages the viewport in a thread", () => {
    expect(resolveAction("next", "thread")).toBe("pageDown");
    expect(resolveAction("prev", "thread")).toBe("pageUp");
  });

  it("ignores an unknown command", () => {
    expect(resolveAction("selfdestruct", "feed")).toBe("noop");
  });
});

describe("commandForKeyCode", () => {
  it("maps every numpad key we bind", () => {
    expect(commandForKeyCode("Numpad0")).toBe("toggle");
    expect(commandForKeyCode("NumpadEnter")).toBe("open");
    expect(commandForKeyCode("NumpadDecimal")).toBe("back");
    expect(commandForKeyCode("NumpadAdd")).toBe("faster");
    expect(commandForKeyCode("NumpadSubtract")).toBe("slower");
    expect(commandForKeyCode("Numpad8")).toBe("prev");
    expect(commandForKeyCode("Numpad2")).toBe("next");
  });

  it("ignores keys we do not bind", () => {
    expect(commandForKeyCode("KeyA")).toBeNull();
    expect(commandForKeyCode("Enter")).toBeNull();
    expect(commandForKeyCode("ArrowDown")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd userscript && npm test`
Expected: FAIL — cannot resolve `../src/commands.js`.

- [ ] **Step 3: Write the routing table**

`userscript/src/commands.js`:

```javascript
/** Which action a command means, given where we currently are. */

export function detectMode(pathname) {
  return pathname.includes("/comments/") ? "thread" : "feed";
}

const ACTIONS = {
  toggle: { feed: "toggleScroll", thread: "toggleScroll" },
  faster: { feed: "speedUp", thread: "speedUp" },
  slower: { feed: "speedDown", thread: "speedDown" },
  open: { feed: "openSelected", thread: "noop" },
  back: { feed: "noop", thread: "goBack" },
  next: { feed: "selectNext", thread: "pageDown" },
  prev: { feed: "selectPrev", thread: "pageUp" },
};

export function resolveAction(command, mode) {
  const byMode = ACTIONS[command];
  if (!byMode) return "noop";
  return byMode[mode] || "noop";
}

// Used only when Firefox itself has focus. The daemon covers the case that
// matters — the game holding focus — but this makes the script usable and
// testable on its own.
const KEY_CODES = {
  Numpad0: "toggle",
  NumpadEnter: "open",
  NumpadDecimal: "back",
  NumpadAdd: "faster",
  NumpadSubtract: "slower",
  Numpad8: "prev",
  Numpad2: "next",
};

export function commandForKeyCode(code) {
  return KEY_CODES[code] || null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd userscript && npm test`
Expected: PASS, 13 new tests.

- [ ] **Step 5: Write the wiring**

`userscript/src/main.js` (replace the placeholder entirely):

```javascript
/** Entry point: wires the transport, scroll engine, selection and HUD together. */

import { commandForKeyCode, detectMode, resolveAction } from "./commands.js";
import { Hud } from "./hud.js";
import { ScrollEngine } from "./scroll.js";
import { Selection } from "./selection.js";
import { Transport, gmRequest } from "./transport.js";

const PORT = 8765;
const STATE_KEY = "rs-scroll-state";
const FLASH_MS = 900;

const DEFAULTS = {
  speed_min: 15,
  speed_max: 600,
  speed_step: 15,
  default_speed: 90,
  focus_line: 0.25,
};

function loadPersisted() {
  try {
    const raw = GM_getValue(STATE_KEY, null);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function persist(state) {
  try {
    GM_setValue(STATE_KEY, JSON.stringify(state));
  } catch {
    // Persistence is a nicety; losing it is not worth breaking over.
  }
}

function boot() {
  const settings = { ...DEFAULTS };
  const persisted = loadPersisted();

  const engine = new ScrollEngine({
    scrollBy: (dy) => window.scrollBy(0, dy),
    requestFrame: (cb) => window.requestAnimationFrame(cb),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    speed: persisted?.speed ?? settings.default_speed,
    min: settings.speed_min,
    max: settings.speed_max,
    step: settings.speed_step,
  });

  const selection = new Selection({
    root: document,
    getViewportHeight: () => window.innerHeight,
    focusLine: settings.focus_line,
  });

  const hud = new Hud(document);
  hud.mount();

  let mode = detectMode(window.location.pathname);
  let daemonConnected = false;
  let lastCommand = null;
  let flashTimer = null;

  function snapshot() {
    return {
      running: engine.running,
      speed: engine.speed,
      speedMin: settings.speed_min,
      speedMax: settings.speed_max,
      mode,
      selected: selection.selected,
      postCount: selection.count,
      daemonConnected,
      lastCommand,
    };
  }

  function paint() {
    hud.render(snapshot());
  }

  function flash(command) {
    lastCommand = command;
    paint();
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      lastCommand = null;
      paint();
    }, FLASH_MS);
  }

  function savePosition() {
    persist({ running: engine.running, speed: engine.speed });
  }

  function scrollToSelected() {
    const element = selection.selectedElement;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const target = window.innerHeight * settings.focus_line;
    window.scrollBy(0, rect.top - target);
  }

  const ACTIONS = {
    toggleScroll() {
      engine.toggle();
      savePosition();
    },
    speedUp() {
      engine.adjustSpeed(settings.speed_step);
      savePosition();
    },
    speedDown() {
      engine.adjustSpeed(-settings.speed_step);
      savePosition();
    },
    openSelected() {
      const post = selection.selected;
      if (!post) return;
      savePosition();
      window.location.href = post.permalink;
    },
    goBack() {
      savePosition();
      window.history.back();
    },
    selectNext() {
      selection.move(1);
      scrollToSelected();
      selection.applyHighlight();
    },
    selectPrev() {
      selection.move(-1);
      scrollToSelected();
      selection.applyHighlight();
    },
    pageDown() {
      window.scrollBy(0, window.innerHeight * 0.8);
    },
    pageUp() {
      window.scrollBy(0, -window.innerHeight * 0.8);
    },
    noop() {},
  };

  function handleCommand(command) {
    flash(command);
    (ACTIONS[resolveAction(command, mode)] || ACTIONS.noop)();
    refresh();
  }

  let refreshQueued = false;
  function refresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    window.requestAnimationFrame(() => {
      refreshQueued = false;
      mode = detectMode(window.location.pathname);
      if (mode === "feed") {
        selection.refresh();
        selection.applyHighlight();
      }
      paint();
    });
  }

  const transport = new Transport({
    port: PORT,
    request: gmRequest,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onCommands: (commands) => {
      // A background tab should not steal commands aimed at the visible one.
      if (document.hidden) return;
      commands.forEach(handleCommand);
    },
    onConnectionChange: (ok) => {
      daemonConnected = ok;
      if (ok && transport.settings) {
        Object.assign(settings, transport.settings);
        // Both were built from built-in defaults; adopt the user's config.
        engine.setLimits(settings.speed_min, settings.speed_max);
        selection.setFocusLine(settings.focus_line);
      }
      paint();
    },
  });

  function isTyping(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  }

  window.addEventListener("scroll", refresh, { passive: true });
  window.addEventListener("keydown", (event) => {
    // Numpad keys typed into Reddit's search box are text, not commands.
    if (isTyping(event.target)) return;
    const command = commandForKeyCode(event.code);
    if (command) handleCommand(command);
  });
  window.addEventListener("pagehide", savePosition);

  setInterval(() => transport.postState(snapshot()), 1000);

  refresh();
  if (persisted?.running) engine.start();
  transport.start();
}

boot();
```

- [ ] **Step 6: Build and verify the output**

Run: `cd userscript && npm run build`
Expected: `built dist/reddit-scroller.user.js`. Confirm the file starts with the `// ==UserScript==` block and that `grep -c "GM_xmlhttpRequest" dist/reddit-scroller.user.js` is at least 2 (the `@grant` line and the call).

- [ ] **Step 7: Run the whole suite**

Run: `cd userscript && npm test`
Expected: PASS, 85 tests.

- [ ] **Step 8: Commit**

```bash
git add userscript/src/main.js userscript/src/commands.js userscript/tests/commands.test.js userscript/dist/reddit-scroller.user.js
git commit -m "feat: wire the userscript together"
```

---

### Task 12: Documentation and end-to-end verification

**Files:**
- Create: `README.md`
- Modify: `.gitignore` (add `spike/`)

**Interfaces:**
- Consumes: everything.
- Produces: a working, documented tool.

- [ ] **Step 1: Write the README**

`README.md`:

````markdown
# Reddit Scroller

Auto-scrolls a Reddit feed in your normal Firefox on a second monitor, driven by
global numpad hotkeys — so you can keep reading without leaving a full-screen game.

Two halves:

- A **userscript** that runs inside your real, already-logged-in Firefox. It owns the
  scrolling, decides which post is "current", and draws the on-screen readout.
- A **Python daemon** that owns the global keyboard hook and hands commands to the
  userscript over `127.0.0.1`.

## Setup

**1. The daemon**

```bash
uv sync
uv run python -m reddit_scroller
```

Leave it running. It prints its bindings on start.

**2. The userscript**

1. Install [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/).
2. Build the script: `cd userscript && npm install && npm run build`
3. Open the Violentmonkey dashboard → **+** → **Install from file**, and pick
   `userscript/dist/reddit-scroller.user.js`.
4. Open `https://www.reddit.com`. The HUD appears bottom-right with a green dot
   next to "daemon".

To pick up changes later, rerun `npm run build` and reinstall the file.

## Controls

| Key | In the feed | In a thread |
|---|---|---|
| Numpad `0` | pause / resume scrolling | pause / resume scrolling |
| Numpad `+` / `-` | speed up / down by 15 px/s | speed up / down by 15 px/s |
| Numpad `8` / `2` | select previous / next post | scroll up / down a screen |
| Numpad `Enter` | open the selected post | — |
| Numpad `.` | — | back to the feed |

The selected post is outlined in blue and named in the HUD. While auto-scrolling it
follows whatever sits a quarter of the way down the screen; pressing `8` or `2` pins
your choice until it scrolls off.

Nothing is suppressed — your game still receives every one of these keys.

## Configuration

Copy `config.example.json` to `config.json` and edit. Every field is optional; anything
you leave out keeps its default.

| Field | Default | Meaning |
|---|---|---|
| `port` | `8765` | Loopback port. |
| `default_speed` | `90` | Starting scroll speed, px/s. |
| `speed_step` | `15` | Change per `faster` / `slower` press. |
| `speed_min` / `speed_max` | `15` / `600` | Speed limits. |
| `focus_line` | `0.25` | Where the "current post" line sits, as a fraction of screen height. |
| `bindings` | see above | Command → key name. |

Valid key names: `numpad0`–`numpad9`, `numpad_dot`, `numpad_plus`, `numpad_minus`,
`numpad_star`, `numpad_enter`.

Commands: `toggle`, `open`, `back`, `faster`, `slower`, `prev`, `next`.

## Troubleshooting

**The HUD says "no daemon".** The daemon is not running, or it is on a different port
than the userscript expects. Check `uv run python -m reddit_scroller` is up and that
`PORT` at the top of `userscript/src/main.js` matches your `config.json`.

**Hotkeys work on the desktop but not in the game.** Windows will not deliver hooked
keys from an elevated window to a non-elevated process. Run the daemon from an
Administrator terminal. Borderless-windowed mode also tends to behave better than
exclusive full-screen.

**The HUD says "no posts detected".** Reddit changed its markup and the
`shreddit-post` selector in `userscript/src/selection.js` needs updating. Scrolling
still works meanwhile.

**Nothing happens on any key.** Check the daemon's console — it logs every hotkey it
sees. If nothing appears there, the problem is the keyboard hook; if lines appear but
the page does not react, the problem is the transport.

## Development

```bash
uv run pytest              # daemon tests
cd userscript && npm test  # userscript tests
```
````

- [ ] **Step 2: Update .gitignore**

Add this line to `.gitignore` (`node_modules/` is already ignored at any depth):

```
spike/
```

- [ ] **Step 3: Run every test**

Run: `uv run pytest -v`
Expected: PASS, 40 tests.

Run: `cd userscript && npm test`
Expected: PASS, 85 tests.

- [ ] **Step 4: End-to-end verification with the user**

Walk through it together:

1. Start the daemon; confirm the bindings print.
2. Build and install the userscript; open reddit.com.
3. Confirm the HUD shows `PAUSED`, `90 px/s`, `FEED`, a green daemon dot, and the
   title of the post a quarter of the way down the screen.
4. Press numpad `0` — the feed scrolls and the HUD reads `SCROLLING`.
5. Press numpad `+` three times — the speed reads `135 px/s` and the bar grows.
6. Press numpad `2` — the outline moves to the next post and it jumps to the focus line.
7. Press numpad `Enter` — the thread opens and scrolling continues.
8. Press numpad `.` — back to the feed at the position you left.
9. Alt-tab into a full-screen game and repeat steps 4–8 without leaving it.
10. Stop the daemon; confirm the HUD dot turns red within about five seconds and the
    page keeps scrolling.

Report any step that misbehaves rather than working around it.

- [ ] **Step 5: Commit**

```bash
git add README.md .gitignore
git commit -m "docs: add setup, controls and troubleshooting"
```

---

## Notes for the implementer

- **Task 1 gates everything.** If the spike fails, stop and say so — the rest of the plan
  assumes plain-HTTP loopback works.
- **Never bind `0.0.0.0`.** This daemon has no authentication because it is unreachable
  from off the machine. That property must not be given up.
- **Never pass `suppress=True`** to a `keyboard` hook. Swallowing a key would take it away
  from the game, which defeats the point of the tool.
- **Test counts in the "Expected" lines are guidance**, not assertions. If you add a test,
  the count moves; that is fine. A *failing* test is not.
