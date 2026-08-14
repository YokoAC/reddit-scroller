"""Loading and validation of the daemon's configuration."""

from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from pathlib import Path

COMMANDS = frozenset(
    {
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
)

# Windows set-1 scan codes. Every numpad key also carries is_keypad=True, which
# is what separates numpad 8 from the up arrow regardless of Num Lock state.
KEY_CODES: dict[str, tuple[int, bool]] = {
    "numpad0": (82, True),
    "numpad1": (79, True),
    "numpad2": (80, True),
    "numpad3": (81, True),
    "numpad4": (75, True),
    "numpad5": (76, True),
    "numpad6": (77, True),
    "numpad7": (71, True),
    "numpad8": (72, True),
    "numpad9": (73, True),
    "numpad_dot": (83, True),
    "numpad_plus": (78, True),
    "numpad_minus": (74, True),
    "numpad_star": (55, True),
    "numpad_enter": (28, True),
}

DEFAULT_BINDINGS: dict[str, str] = {
    "toggle": "numpad0",
    "open": "numpad_enter",
    "back": "numpad_dot",
    "faster": "numpad_plus",
    "slower": "numpad_minus",
    "prev": "numpad8",
    "next": "numpad2",
    "reverse": "numpad5",
    "help": "numpad_star",
}

# KEY_CODES values are unique, so the mapping inverts cleanly. The help panel
# needs to show the key names the user actually configured.
_NAMES_BY_CODE: dict[tuple[int, bool], str] = {
    code: name for name, code in KEY_CODES.items()
}


class ConfigError(Exception):
    """Raised when config.json cannot be understood."""


@dataclass(frozen=True)
class KeyBinding:
    scan_code: int
    is_keypad: bool


@dataclass(frozen=True)
class Config:
    port: int = 8765
    default_speed: float = 90.0
    speed_step: float = 15.0
    speed_min: float = 15.0
    speed_max: float = 600.0
    focus_line: float = 0.25
    bindings: dict[str, KeyBinding] = field(default_factory=dict)

    @classmethod
    def default(cls) -> "Config":
        return cls(bindings=_resolve_bindings(DEFAULT_BINDINGS))

    def lookup(self, scan_code: int, is_keypad: bool) -> str | None:
        """Return the command bound to a physical key, or None."""
        for command, binding in self.bindings.items():
            if binding.scan_code == scan_code and binding.is_keypad == is_keypad:
                return command
        return None

    def binding_names(self) -> dict[str, str]:
        """Command -> key name, as configured. Drives the help panel."""
        return {
            command: _NAMES_BY_CODE[(binding.scan_code, binding.is_keypad)]
            for command, binding in self.bindings.items()
        }

    def browser_settings(self) -> dict:
        """The subset of config the userscript needs to know about."""
        return {
            "speed_min": self.speed_min,
            "speed_max": self.speed_max,
            "speed_step": self.speed_step,
            "default_speed": self.default_speed,
            "focus_line": self.focus_line,
            "bindings": self.binding_names(),
        }


def _resolve_bindings(names: dict[str, str]) -> dict[str, KeyBinding]:
    resolved: dict[str, KeyBinding] = {}
    seen: dict[str, str] = {}
    for command, key_name in names.items():
        if command not in COMMANDS:
            raise ConfigError(
                f"unknown command {command!r} in bindings; "
                f"expected one of {sorted(COMMANDS)}"
            )
        if key_name not in KEY_CODES:
            raise ConfigError(
                f"unknown key {key_name!r} for command {command!r}; "
                f"expected one of {sorted(KEY_CODES)}"
            )
        if key_name in seen:
            raise ConfigError(
                f"key {key_name!r} is bound to both {seen[key_name]!r} "
                f"and {command!r}"
            )
        seen[key_name] = command
        scan_code, is_keypad = KEY_CODES[key_name]
        resolved[command] = KeyBinding(scan_code=scan_code, is_keypad=is_keypad)
    return resolved


def _validate(cfg: Config) -> None:
    if not 1 <= cfg.port <= 65535:
        raise ConfigError(f"port must be between 1 and 65535, got {cfg.port}")
    if cfg.speed_min <= 0:
        raise ConfigError(f"speed_min must be positive, got {cfg.speed_min}")
    if cfg.speed_max <= cfg.speed_min:
        raise ConfigError(
            f"speed_max ({cfg.speed_max}) must exceed speed_min ({cfg.speed_min})"
        )
    if cfg.speed_step <= 0:
        raise ConfigError(f"speed_step must be positive, got {cfg.speed_step}")
    if not cfg.speed_min <= cfg.default_speed <= cfg.speed_max:
        raise ConfigError(
            f"default_speed ({cfg.default_speed}) must lie between "
            f"speed_min ({cfg.speed_min}) and speed_max ({cfg.speed_max})"
        )
    if not 0.0 < cfg.focus_line < 1.0:
        raise ConfigError(
            f"focus_line must be between 0 and 1 exclusive, got {cfg.focus_line}"
        )


def load_config(path: Path) -> Config:
    """Load config from *path*, falling back to defaults when it is absent."""
    if not path.exists():
        return Config.default()

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{path.name} is not valid JSON: {exc}") from exc

    if not isinstance(raw, dict):
        raise ConfigError(f"{path.name} must contain a JSON object")

    bindings_raw = raw.pop("bindings", {})
    if not isinstance(bindings_raw, dict):
        raise ConfigError(
            f"bindings must be a JSON object mapping commands to key names, "
            f"got {bindings_raw!r}"
        )

    binding_names = dict(DEFAULT_BINDINGS)
    binding_names.update(bindings_raw)

    known = {f for f in Config.__dataclass_fields__ if f != "bindings"}
    unknown = set(raw) - known
    if unknown:
        raise ConfigError(f"unknown setting(s): {', '.join(sorted(unknown))}")

    numeric: dict[str, float | int] = {}
    for key, value in raw.items():
        try:
            numeric[key] = int(value) if key == "port" else float(value)
        except (TypeError, ValueError) as exc:
            raise ConfigError(f"{key} must be a number, got {value!r}") from exc

    cfg = replace(
        Config.default(),
        bindings=_resolve_bindings(binding_names),
        **numeric,
    )
    _validate(cfg)
    return cfg
