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
