import asyncio
from dataclasses import replace

import aiohttp
import pytest
from aiohttp import web

from reddit_scroller import __main__ as daemon
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


async def test_cleanup_runs_when_listener_stop_raises(monkeypatch):
    """runner.cleanup() must still run even if listener.stop() raises, or the
    AppRunner (and its listening socket) leaks on an otherwise-normal Ctrl+C
    shutdown. A FakeListener whose stop() raises stands in for a real hook
    teardown failure (keyboard.unhook() has no internal error handling)."""
    cleanup_calls = []
    original_cleanup = web.AppRunner.cleanup

    async def tracking_cleanup(self):
        cleanup_calls.append(True)
        await original_cleanup(self)

    monkeypatch.setattr(web.AppRunner, "cleanup", tracking_cleanup)

    class RaisingListener(FakeListener):
        def stop(self):
            super().stop()
            raise RuntimeError("hook teardown failed")

    config = replace(Config.default(), port=8797)
    task = asyncio.create_task(run(config, listener_factory=RaisingListener))
    await asyncio.sleep(0.2)

    # Cancelling stands in for Ctrl+C: it triggers the shutdown `finally`.
    # listener.stop()'s RuntimeError takes over from the CancelledError as it
    # propagates, so the task ends in RuntimeError rather than being cancelled.
    task.cancel()
    with pytest.raises(RuntimeError, match="hook teardown failed"):
        await task

    assert cleanup_calls, "runner.cleanup() must run even when listener.stop() raises"


def test_main_does_not_report_a_non_bind_oserror_as_a_bind_failure(
    monkeypatch, capsys
):
    """An OSError that escapes run() for a reason other than the port bind
    (e.g. from hook teardown during shutdown) must propagate unchanged, not
    get mislabeled as 'could not bind ... another daemon may already be
    running'."""

    async def raising_run(config, listener_factory=None):
        raise OSError("hook teardown failed")

    monkeypatch.setattr(daemon, "run", raising_run)

    with pytest.raises(OSError, match="hook teardown failed"):
        daemon.main()

    captured = capsys.readouterr()
    assert "could not bind" not in captured.err
