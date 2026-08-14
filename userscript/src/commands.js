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

// Used only when Firefox itself has focus. The daemon covers the case that
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

export function commandForKeyCode(code) {
  return KEY_CODES[code] || null;
}
