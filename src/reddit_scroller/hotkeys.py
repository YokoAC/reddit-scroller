"""The global keyboard hook that turns numpad presses into commands."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .config import Config

# Commands that should keep firing while their key is held, letting Windows'
# auto-repeat ramp the value. Every other command fires once per physical
# press, so a finger resting on the toggle key cannot strobe the scroller and
# a held open key cannot fire a burst of navigations.
REPEAT_ON_HOLD = frozenset({"faster", "slower"})


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
        self._hooks: list[Any] = []

    @staticmethod
    def _identity(event: Any) -> tuple[int, bool]:
        return (
            getattr(event, "scan_code", -1),
            bool(getattr(event, "is_keypad", False)),
        )

    def handle_press(self, event: Any) -> str | None:
        identity = self._identity(event)
        command = self._config.lookup(*identity)
        if command is None:
            return None
        if identity in self._held and command not in REPEAT_ON_HOLD:
            return None  # Windows auto-repeat, not a new press.
        self._held.add(identity)
        self._on_command(command)
        return command

    def handle_release(self, event: Any) -> None:
        self._held.discard(self._identity(event))

    def handle_event(self, event: Any) -> None:
        """Route one raw key event. Always returns None.

        This must stay a single hook rather than a keyboard.on_press plus a
        keyboard.on_release pair. keyboard's dispatch loop stops at the first
        handler returning truthy, and its on_press wrapper returns True for
        every key-up -- which swallowed the release before a separately
        registered on_release hook could see it. _held then never cleared and
        each key fired exactly once per daemon lifetime.

        Returning None also keeps us from suppressing anyone else's handler.
        """
        if getattr(event, "event_type", None) == "up":
            self.handle_release(event)
        else:
            self.handle_press(event)

    def start(self) -> None:
        import keyboard

        self._hooks = [keyboard.hook(self.handle_event, suppress=False)]

    def stop(self) -> None:
        import keyboard

        for hook in self._hooks:
            keyboard.unhook(hook)
        self._hooks = []
        self._held.clear()
