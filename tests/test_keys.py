import pytest

from reddit_scroller.config import (
    COMMANDS,
    KEY_CODES,
    Config,
    ConfigError,
    KeyBinding,
    resolve_codes,
)
from reddit_scroller.keys import CODES


def test_every_key_has_its_own_identity():
    # Two codes sharing (scan_code, is_keypad) could not be told apart by the
    # hook, so binding one would silently bind the other.
    assert len(set(CODES.values())) == len(CODES)


def test_the_numpad_codes_agree_with_the_names_config_json_uses():
    by_name = {
        "numpad_dot": "NumpadDecimal",
        "numpad_plus": "NumpadAdd",
        "numpad_minus": "NumpadSubtract",
        "numpad_star": "NumpadMultiply",
        "numpad_slash": "NumpadDivide",
        "numpad_enter": "NumpadEnter",
        **{f"numpad{n}": f"Numpad{n}" for n in range(10)},
    }
    assert set(by_name) == set(KEY_CODES)
    for name, code in by_name.items():
        assert CODES[code] == KEY_CODES[name], name


@pytest.mark.parametrize(
    ("code", "identity"),
    [
        ("Space", (57, False)),
        ("KeyF", (33, False)),
        ("Digit1", (2, False)),
        ("Backspace", (14, False)),
        ("F13", (100, False)),
        # The pairs that share a scan code, split only by the keypad flag.
        ("Enter", (28, False)),
        ("NumpadEnter", (28, True)),
        ("ArrowUp", (72, False)),
        ("Numpad8", (72, True)),
        ("Slash", (53, False)),
        ("NumpadDivide", (53, True)),
        ("Delete", (83, False)),
        ("NumpadDecimal", (83, True)),
    ],
)
def test_known_keys_map_to_their_scan_codes(code, identity):
    assert CODES[code] == identity


def test_modifiers_are_not_bindable():
    # Left and right share a scan code, and a held modifier would fire its
    # command on every shortcut the user types.
    for code in ("ShiftLeft", "ControlRight", "AltLeft", "MetaLeft"):
        assert code not in CODES


def test_default_bindings_are_reported_as_codes():
    codes = Config.default().binding_codes()
    assert set(codes) == COMMANDS
    assert codes["toggle"] == "Numpad0"
    assert codes["faster"] == "NumpadAdd"
    assert Config.default().browser_settings()["binding_codes"] == codes


def test_codes_resolve_to_bindings():
    result = resolve_codes({"toggle": "Space", "next": "ArrowDown"})
    assert result.bindings == {
        "toggle": KeyBinding(scan_code=57, is_keypad=False),
        "next": KeyBinding(scan_code=80, is_keypad=False),
    }
    assert result.codes == {"toggle": "Space", "next": "ArrowDown"}
    assert result.unsupported == []


def test_an_unbound_command_is_simply_left_out():
    result = resolve_codes({"toggle": "Space", "open": None})
    assert set(result.bindings) == {"toggle"}
    assert result.unsupported == []


def test_a_key_the_daemon_cannot_hook_is_reported_not_fatal():
    result = resolve_codes({"toggle": "Space", "open": "MediaPlayPause"})
    assert set(result.bindings) == {"toggle"}
    assert result.unsupported == ["open"]


def test_a_key_sent_twice_binds_only_the_first_command():
    result = resolve_codes({"toggle": "Space", "open": "Space"})
    assert set(result.bindings) == {"toggle"}
    assert result.unsupported == ["open"]


@pytest.mark.parametrize(
    "payload",
    [
        ["toggle"],
        "toggle",
        None,
        {"launch_missiles": "Space"},
        {"toggle": 57},
        {"toggle": ["Space"]},
    ],
)
def test_a_malformed_payload_is_rejected(payload):
    with pytest.raises(ConfigError):
        resolve_codes(payload)
