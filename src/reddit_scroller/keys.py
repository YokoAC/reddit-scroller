"""Physical keys, named as the browser names them.

The userscript identifies a key by ``KeyboardEvent.code`` -- its position on
the keyboard, whatever the layout prints on it. The hook sees a Windows set-1
scan code plus the ``keyboard`` library's ``is_keypad`` flag. This table joins
the two, so one binding means the same key on both sides.

The flag is what separates the pairs that share a scan code: Enter and numpad
Enter, the arrows and numpad 2/4/6/8, ``/`` and numpad ``/``, the
Insert/Delete/Home/End block and the numpad digits under it.

Modifiers are left out on purpose. Left and right share a scan code, and a
held modifier would fire its command on every shortcut the user types.
"""

from __future__ import annotations

_ROWS = {
    "Backquote": 41,
    "Digit1": 2,
    "Digit2": 3,
    "Digit3": 4,
    "Digit4": 5,
    "Digit5": 6,
    "Digit6": 7,
    "Digit7": 8,
    "Digit8": 9,
    "Digit9": 10,
    "Digit0": 11,
    "Minus": 12,
    "Equal": 13,
    "Backspace": 14,
    "Tab": 15,
    "KeyQ": 16,
    "KeyW": 17,
    "KeyE": 18,
    "KeyR": 19,
    "KeyT": 20,
    "KeyY": 21,
    "KeyU": 22,
    "KeyI": 23,
    "KeyO": 24,
    "KeyP": 25,
    "BracketLeft": 26,
    "BracketRight": 27,
    "Enter": 28,
    "KeyA": 30,
    "KeyS": 31,
    "KeyD": 32,
    "KeyF": 33,
    "KeyG": 34,
    "KeyH": 35,
    "KeyJ": 36,
    "KeyK": 37,
    "KeyL": 38,
    "Semicolon": 39,
    "Quote": 40,
    "Backslash": 43,
    "KeyZ": 44,
    "KeyX": 45,
    "KeyC": 46,
    "KeyV": 47,
    "KeyB": 48,
    "KeyN": 49,
    "KeyM": 50,
    "Comma": 51,
    "Period": 52,
    "Slash": 53,
    "Space": 57,
    "CapsLock": 58,
    "ScrollLock": 70,
    "IntlBackslash": 86,
}

_FUNCTION = {
    **{f"F{n}": 58 + n for n in range(1, 11)},
    "F11": 87,
    "F12": 88,
    **{f"F{n}": 87 + n for n in range(13, 24)},
    "F24": 118,
}

# The same scan codes as the numpad keys below; only the flag differs.
_NAVIGATION = {
    "Home": 71,
    "ArrowUp": 72,
    "PageUp": 73,
    "ArrowLeft": 75,
    "ArrowRight": 77,
    "End": 79,
    "ArrowDown": 80,
    "PageDown": 81,
    "Insert": 82,
    "Delete": 83,
}

_NUMPAD = {
    "NumpadEnter": 28,
    "NumpadDivide": 53,
    "NumpadMultiply": 55,
    "Numpad7": 71,
    "Numpad8": 72,
    "Numpad9": 73,
    "NumpadSubtract": 74,
    "Numpad4": 75,
    "Numpad5": 76,
    "Numpad6": 77,
    "NumpadAdd": 78,
    "Numpad1": 79,
    "Numpad2": 80,
    "Numpad3": 81,
    "Numpad0": 82,
    "NumpadDecimal": 83,
}

#: ``KeyboardEvent.code`` -> ``(scan_code, is_keypad)``.
CODES: dict[str, tuple[int, bool]] = {
    **{code: (scan, False) for code, scan in _ROWS.items()},
    **{code: (scan, False) for code, scan in _FUNCTION.items()},
    **{code: (scan, False) for code, scan in _NAVIGATION.items()},
    **{code: (scan, True) for code, scan in _NUMPAD.items()},
}
