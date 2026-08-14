import json

import pytest

from reddit_scroller.config import Config, ConfigError, KeyBinding, load_config


def test_defaults_match_the_spec():
    cfg = Config.default()
    assert cfg.port == 8765
    assert cfg.default_speed == 90.0
    assert cfg.speed_step == 15.0
    assert cfg.speed_min == 15.0
    assert cfg.speed_max == 600.0
    assert cfg.focus_line == 0.25


def test_default_bindings_cover_every_command():
    cfg = Config.default()
    assert set(cfg.bindings) == {
        "toggle",
        "open",
        "back",
        "faster",
        "slower",
        "prev",
        "next",
        "reverse",
        "help",
    }
    assert cfg.bindings["toggle"] == KeyBinding(scan_code=82, is_keypad=True)
    assert cfg.bindings["next"] == KeyBinding(scan_code=80, is_keypad=True)
    assert cfg.bindings["open"] == KeyBinding(scan_code=28, is_keypad=True)


def test_lookup_resolves_keypad_keys_and_ignores_their_non_keypad_twins():
    cfg = Config.default()
    assert cfg.lookup(80, is_keypad=True) == "next"
    # Scan code 80 with is_keypad False is the Down arrow, which is not ours.
    assert cfg.lookup(80, is_keypad=False) is None
    assert cfg.lookup(999, is_keypad=True) is None


def test_missing_file_yields_defaults(tmp_path):
    assert load_config(tmp_path / "nope.json") == Config.default()


def test_partial_file_overrides_only_named_fields(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"port": 9000, "default_speed": 120}))
    cfg = load_config(path)
    assert cfg.port == 9000
    assert cfg.default_speed == 120.0
    assert cfg.speed_step == 15.0
    assert cfg.bindings == Config.default().bindings


def test_partial_bindings_merge_over_defaults(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"bindings": {"toggle": "numpad1"}}))
    cfg = load_config(path)
    assert cfg.bindings["toggle"] == KeyBinding(scan_code=79, is_keypad=True)
    assert cfg.bindings["back"] == Config.default().bindings["back"]


def test_unknown_command_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"bindings": {"explode": "numpad5"}}))
    with pytest.raises(ConfigError, match="explode"):
        load_config(path)


def test_unknown_key_name_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"bindings": {"toggle": "banana"}}))
    with pytest.raises(ConfigError, match="banana"):
        load_config(path)


def test_duplicate_key_across_two_commands_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"bindings": {"toggle": "numpad2"}}))
    with pytest.raises(ConfigError, match="numpad2"):
        load_config(path)


def test_bindings_as_a_string_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"bindings": "numpad0"}))
    with pytest.raises(ConfigError, match="bindings"):
        load_config(path)


def test_bindings_as_a_list_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"bindings": [1, 2]}))
    with pytest.raises(ConfigError, match="bindings"):
        load_config(path)


def test_default_speed_outside_the_range_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"default_speed": 5}))
    with pytest.raises(ConfigError, match="default_speed"):
        load_config(path)


def test_focus_line_outside_the_viewport_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"focus_line": 1.5}))
    with pytest.raises(ConfigError, match="focus_line"):
        load_config(path)


def test_invalid_json_is_reported_as_a_config_error(tmp_path):
    path = tmp_path / "config.json"
    path.write_text("{not json")
    with pytest.raises(ConfigError, match="config.json"):
        load_config(path)


def test_an_unknown_setting_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"scroll_speed": 90}))
    with pytest.raises(ConfigError, match="scroll_speed"):
        load_config(path)


def test_a_non_numeric_setting_is_rejected(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"default_speed": "fast"}))
    with pytest.raises(ConfigError, match="default_speed"):
        load_config(path)


def test_browser_settings_carry_only_what_the_page_needs():
    settings = Config.default().browser_settings()
    assert settings["speed_min"] == 15.0
    assert settings["speed_max"] == 600.0
    assert settings["speed_step"] == 15.0
    assert settings["default_speed"] == 90.0
    assert settings["focus_line"] == 0.25


def test_the_two_new_commands_are_in_the_vocabulary():
    cfg = Config.default()
    assert cfg.bindings["reverse"] == KeyBinding(scan_code=76, is_keypad=True)
    assert cfg.bindings["help"] == KeyBinding(scan_code=55, is_keypad=True)
    assert cfg.lookup(76, is_keypad=True) == "reverse"
    assert cfg.lookup(55, is_keypad=True) == "help"


def test_binding_names_round_trip_back_to_key_names():
    # The help panel renders the user's ACTUAL bindings, so the daemon has to
    # report the key names it resolved, not just the scan codes.
    names = Config.default().binding_names()
    assert names["toggle"] == "numpad0"
    assert names["reverse"] == "numpad5"
    assert names["help"] == "numpad_star"
    assert set(names) == set(Config.default().bindings)


def test_binding_names_follow_a_rebinding(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"bindings": {"reverse": "numpad9"}}))
    assert load_config(path).binding_names()["reverse"] == "numpad9"


def test_browser_settings_carries_the_bindings():
    settings = Config.default().browser_settings()
    assert settings["default_speed"] == 90.0
    assert settings["bindings"]["faster"] == "numpad_plus"
