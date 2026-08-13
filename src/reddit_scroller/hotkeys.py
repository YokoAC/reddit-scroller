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
