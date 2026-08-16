"""The append-only command log shared by the hotkey hook and the HTTP server."""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Event:
    seq: int
    command: str

    def as_dict(self) -> dict[str, int | str]:
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
        self._state: dict[str, Any] = {}
        self._waiters: list[asyncio.Future[None]] = []
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
        except TimeoutError:
            pass
        finally:
            if waiter in self._waiters:
                self._waiters.remove(waiter)
        return self.since(cursor)

    def set_state(self, state: dict[str, Any]) -> None:
        self._state = state

    def get_state(self) -> dict[str, Any]:
        return self._state
