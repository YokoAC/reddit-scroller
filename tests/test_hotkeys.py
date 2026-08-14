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


# --- Single-dispatcher regression tests -------------------------------------
#
# These cover a bug that unit-testing handle_press/handle_release directly
# could never catch, because it lived in how two keyboard-library hooks
# compose rather than in either handler.
#
# keyboard's dispatch loop (_generic.py invoke_handlers) stops as soon as a
# handler returns truthy. keyboard.on_press(cb) registers
# `lambda e: e.event_type == KEY_UP or cb(e)`, which returns True on every
# key-up -- halting the loop before a separately registered on_release hook
# ever runs. The release handler never fired, _held never cleared, and each
# key worked exactly once per daemon lifetime.


def event(scan_code: int, event_type: str, is_keypad: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        scan_code=scan_code, is_keypad=is_keypad, name=None, event_type=event_type
    )


def invoke_handlers(handlers, ev):
    """Faithful copy of keyboard._generic.GenericListener.invoke_handlers."""
    for handler in handlers:
        if handler(ev):
            return 1
    return None


def test_the_dispatcher_routes_a_press_to_the_command():
    hk, fired = listener()
    hk.handle_event(event(82, "down"))
    assert fired == ["toggle"]


def test_the_dispatcher_routes_a_release_so_the_key_can_fire_again():
    hk, fired = listener()
    hk.handle_event(event(82, "down"))
    hk.handle_event(event(82, "up"))
    hk.handle_event(event(82, "down"))
    assert fired == ["toggle", "toggle"]


def test_the_dispatcher_never_returns_truthy():
    # A truthy return would halt keyboard's handler loop for every other
    # listener on the system -- and, if we ever register a second hook, for
    # ourselves.
    hk, _ = listener()
    assert not hk.handle_event(event(82, "down"))
    assert not hk.handle_event(event(82, "up"))
    assert not hk.handle_event(event(999, "down"))


def test_a_repeated_key_survives_the_libraries_dispatch_loop():
    # The end-to-end regression: our handlers, dispatched exactly the way
    # keyboard does it, must fire on every real press.
    hk, fired = listener()
    handlers = [hk.handle_event]
    for event_type in ("down", "up", "down", "up", "down"):
        invoke_handlers(handlers, event(82, event_type))
    assert fired == ["toggle", "toggle", "toggle"]


def test_auto_repeat_is_still_collapsed_through_the_dispatcher():
    hk, fired = listener()
    for _ in range(5):
        hk.handle_event(event(82, "down"))
    hk.handle_event(event(82, "up"))
    hk.handle_event(event(82, "down"))
    assert fired == ["toggle", "toggle"]


def test_holding_the_speed_keys_ramps_continuously():
    # Windows auto-repeat is what drives the ramp; the speed keys deliberately
    # opt out of the one-shot guard so a held + walks the speed up.
    hk, fired = listener()
    for _ in range(4):
        hk.handle_event(event(78, "down"))  # numpad +
    assert fired == ["faster"] * 4

    fired.clear()
    for _ in range(3):
        hk.handle_event(event(74, "down"))  # numpad -
    assert fired == ["slower"] * 3


def test_holding_any_other_key_still_fires_once():
    # A finger resting on numpad 0 must not strobe the scroller, and a held
    # Enter must not fire a burst of navigations.
    hk, fired = listener()
    for scan_code in (82, 28, 83, 72, 80, 76, 55):
        for _ in range(4):
            hk.handle_event(event(scan_code, "down"))
    assert fired == ["toggle", "open", "back", "prev", "next", "reverse", "help"]


def test_a_ramping_key_still_clears_on_release():
    hk, fired = listener()
    hk.handle_event(event(78, "down"))
    hk.handle_event(event(78, "up"))
    hk.handle_event(event(78, "down"))
    assert fired == ["faster", "faster"]
