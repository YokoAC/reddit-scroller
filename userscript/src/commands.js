/** Which action a command means, given where we currently are. */

export function detectMode(pathname) {
  return pathname.includes("/comments/") ? "thread" : "feed";
}

const ACTIONS = {
  toggle: { feed: "toggleScroll", thread: "toggleScroll" },
  faster: { feed: "speedUp", thread: "speedUp" },
  slower: { feed: "speedDown", thread: "speedDown" },
  open: { feed: "openSelected", thread: "noop" },
  back: { feed: "noop", thread: "goBack" },
  next: { feed: "selectNext", thread: "pageDown" },
  prev: { feed: "selectPrev", thread: "pageUp" },
  reverse: { feed: "flipDirection", thread: "flipDirection" },
  help: { feed: "toggleHelp", thread: "toggleHelp" },
};

export function resolveAction(command, mode) {
  const byMode = ACTIONS[command];
  if (!byMode) return "noop";
  return byMode[mode] || "noop";
}

// Used only when the browser itself has focus. The daemon covers the case that
// matters — the game holding focus — but this makes the script usable and
// testable on its own.
const KEY_CODES = {
  Numpad0: "toggle",
  NumpadEnter: "open",
  NumpadDecimal: "back",
  NumpadAdd: "faster",
  NumpadSubtract: "slower",
  Numpad8: "prev",
  Numpad2: "next",
  Numpad5: "reverse",
  NumpadMultiply: "help",
};

/**
 * The bindings this script assumes when the daemon has not told us otherwise.
 * Mirrors DEFAULT_BINDINGS in config.py, and matches the KEY_CODES fallback
 * above -- so with the daemon down, these are genuinely the keys that work.
 */
export const DEFAULT_BINDINGS = {
  toggle: "numpad0",
  open: "numpad_enter",
  back: "numpad_dot",
  faster: "numpad_plus",
  slower: "numpad_minus",
  prev: "numpad8",
  next: "numpad2",
  reverse: "numpad5",
  help: "numpad_star",
};

export function commandForKeyCode(code) {
  return KEY_CODES[code] || null;
}
