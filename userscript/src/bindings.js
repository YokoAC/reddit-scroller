/** The page's own key bindings: presets, storage format, and lookups. */

import { KEY_CODES } from "./commands.js";

// Keys are KeyboardEvent.code values: the physical position, so a layout
// switch does not move a binding.
export const PRESETS = {
  // The defaults, kept in commands.js; here only turned command -> key.
  numpad: Object.fromEntries(
    Object.entries(KEY_CODES).map(([code, command]) => [command, code]),
  ),
  // Only keys that sit in the same place on QWERTY and QWERTZ.
  laptop: {
    toggle: "Space",
    open: "Enter",
    back: "Backspace",
    faster: "KeyF",
    slower: "KeyS",
    prev: "ArrowUp",
    next: "ArrowDown",
    reverse: "KeyR",
    help: "KeyH",
    standby: "KeyO",
    image_prev: "ArrowLeft",
    image_next: "ArrowRight",
  },
};

const COMMANDS = Object.keys(PRESETS.numpad);

// Keys whose `event.key` is not a printable character, or (numpad) is one
// that would be mistaken for the main-row key.
const NAMED = {
  NumpadDecimal: "Num .",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num −",
  NumpadMultiply: "Num *",
  NumpadDivide: "Num /",
  NumpadEnter: "Num Enter",
  Space: "Space",
  Enter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  Delete: "Delete",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** What to show for a key: its name, else the character pressed, else the code. */
export function labelFor(code, key) {
  if (NAMED[code]) return NAMED[code];
  const numpad = code.match(/^Numpad(\d)$/);
  if (numpad) return `Num ${numpad[1]}`;
  if (typeof key === "string" && key.length === 1) return key.toUpperCase();
  const plain = code.match(/^(?:Key|Digit)(.)$/);
  return plain ? plain[1] : code;
}

export function fromPreset(name) {
  return Object.fromEntries(
    Object.entries(PRESETS[name]).map(([command, code]) => [
      command,
      { code, label: labelFor(code) },
    ]),
  );
}

/**
 * Bindings from whatever GM storage holds. The value is user-editable, so
 * every command is checked on its own and falls back to the numpad default.
 */
export function parseStored(raw) {
  let stored = raw;
  if (typeof raw === "string") {
    try {
      stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    stored = {};
  }

  const defaults = fromPreset("numpad");
  const result = {};
  const taken = new Set();
  for (const command of COMMANDS) {
    const entry = stored[command];
    let binding = defaults[command];
    if (entry === null) {
      binding = null;
    } else if (
      entry &&
      typeof entry.code === "string" &&
      typeof entry.label === "string"
    ) {
      binding = { code: entry.code, label: entry.label };
    }
    // One key, one command: a duplicate would make the second unreachable.
    if (binding && taken.has(binding.code)) binding = null;
    if (binding) taken.add(binding.code);
    result[command] = binding;
  }
  return result;
}

/** command -> key code or null: what the daemon is sent. */
export function toCodes(bindings) {
  return Object.fromEntries(
    COMMANDS.map((command) => [command, bindings[command]?.code ?? null]),
  );
}

/**
 * Bindings from the command -> key code map the daemon reports. A command it
 * does not mention has no key there, so it has none here either.
 */
export function fromCodes(codes) {
  const source = codes && typeof codes === "object" ? codes : {};
  return Object.fromEntries(
    COMMANDS.map((command) => {
      const code = source[command];
      return [
        command,
        typeof code === "string" ? { code, label: labelFor(code) } : null,
      ];
    }),
  );
}

/** `bindings` with `code` on `command`, taken from whichever command had it. */
export function assign(bindings, command, code, key) {
  const next = {};
  for (const [other, binding] of Object.entries(bindings)) {
    next[other] = binding?.code === code ? null : binding;
  }
  next[command] = { code, label: labelFor(code, key) };
  return next;
}

export function commandFor(bindings, code) {
  for (const [command, binding] of Object.entries(bindings)) {
    if (binding?.code === code) return command;
  }
  return null;
}

/** command -> label, for the help panel. Unbound commands are left out. */
export function labelsOf(bindings) {
  return Object.fromEntries(
    Object.entries(bindings)
      .filter(([, binding]) => binding)
      .map(([command, binding]) => [command, binding.label]),
  );
}
