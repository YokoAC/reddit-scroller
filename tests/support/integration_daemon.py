"""The real daemon, minus the keyboard hook, for cross-half integration tests.

Runs the genuine EventBus and aiohttp app so the userscript's Transport can be
driven against the real wire protocol rather than a hand-written stub. Stubs on
both sides is exactly how the cursor contract drifted twice without a single
test failing.

Commands arrive one per line on stdin and are appended via
`append_threadsafe` from a worker thread -- the same seam, and the same
method, the real keyboard hook uses. No global hook is installed, so this is
safe to run in CI and on a developer's machine.

Usage: python -m tests.support.integration_daemon <port> [poll_timeout]
Prints "READY <port>" on stdout once it is accepting connections.
"""

from __future__ import annotations

import asyncio
import sys
import threading
from dataclasses import replace

from aiohttp import web

from reddit_scroller.bus import EventBus
from reddit_scroller.config import Config
from reddit_scroller.server import create_app


def _pump_stdin(bus: EventBus) -> None:
    """Feed commands from stdin into the bus, as the hook thread would."""
    for line in sys.stdin:
        command = line.strip()
        if command:
            bus.append_threadsafe(command)


async def main() -> None:
    port = int(sys.argv[1])
    poll_timeout = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0

    config = replace(Config.default(), port=port)
    bus = EventBus()
    bus.bind_loop(asyncio.get_running_loop())

    app = create_app(bus, config.browser_settings(), poll_timeout=poll_timeout)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()

    threading.Thread(target=_pump_stdin, args=(bus,), daemon=True).start()
    print(f"READY {port}", flush=True)

    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
