"""Daemon entry point: wires the hotkey hook to the loopback server."""

from __future__ import annotations

import asyncio
import sys
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from aiohttp import web

from .bus import EventBus
from .config import Config, ConfigError, KeyBinding, load_config
from .hotkeys import HotkeyListener
from .server import create_app

CONFIG_PATH = Path(__file__).resolve().parents[2] / "config.json"


class PortUnavailableError(OSError):
    """Raised when the daemon's loopback port cannot be bound.

    Subclasses OSError so callers that only care "did the bind fail" can
    still catch OSError, while main() can catch this specific type to print
    its friendly message without mislabeling unrelated OSErrors (e.g. from
    hotkey hook teardown) as bind failures.

    Carries the port and the original OSError that triggered it.
    """

    def __init__(self, port: int, original: OSError) -> None:
        super().__init__(f"could not bind 127.0.0.1:{port}: {original}")
        self.port = port
        self.original = original


def log(message: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {message}", flush=True)


def log_bindings(bindings: dict[str, KeyBinding]) -> None:
    for command, binding in sorted(bindings.items()):
        log(f"  {command:<10} scan={binding.scan_code} keypad={binding.is_keypad}")


async def run(
    config: Config,
    listener_factory: Callable[[Config, Callable[[str], None]], Any] = HotkeyListener,
) -> None:
    bus = EventBus()
    bus.bind_loop(asyncio.get_running_loop())

    def on_command(command: str) -> None:
        log(f"hotkey  {command}")
        bus.append_threadsafe(command)

    # The userscript may send its own keys. They are kept here, not in
    # config.json: the page is the source of truth and re-sends on connect.
    current = dict(config.bindings)
    listeners: list[Any] = []

    def on_bindings(bindings: dict[str, KeyBinding]) -> None:
        current.clear()
        current.update(bindings)
        for active in listeners:
            active.set_bindings(current)
        log("keys set by the userscript")
        log_bindings(current)

    app = create_app(bus, config.browser_settings(), on_bindings=on_bindings)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", config.port)
    try:
        await site.start()
    except OSError as exc:
        await runner.cleanup()
        raise PortUnavailableError(config.port, exc) from exc

    # Only hook the keyboard once the port is ours — a failed start must not
    # leave a global hook installed.
    listener = listener_factory(config, on_command)
    # A request can land between the port opening and this line.
    listener.set_bindings(current)
    listeners.append(listener)
    listener.start()

    log(f"listening on http://127.0.0.1:{config.port}")
    log_bindings(current)
    log("waiting for the userscript to connect (Ctrl+C to stop)")

    try:
        await asyncio.Event().wait()
    finally:
        try:
            listener.stop()
        finally:
            await runner.cleanup()


def main() -> int:
    try:
        config = load_config(CONFIG_PATH)
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 1

    if not CONFIG_PATH.exists():
        log(f"no {CONFIG_PATH.name} found - using defaults")

    try:
        asyncio.run(run(config))
    except KeyboardInterrupt:
        log("stopped")
    except PortUnavailableError as exc:
        print(
            f"could not bind 127.0.0.1:{exc.port} ({exc.original}). "
            "Another daemon may already be running. To move this one, set "
            "'port' in config.json and set the userscript's 'rs-port' value to "
            "match, in your userscript manager -- both sides, or the page keeps "
            "polling the old port.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
