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
  standby: { feed: "toggleStandby", thread: "toggleStandby" },
  image_prev: { feed: "imagePrev", thread: "imagePrev" },
  image_next: { feed: "imageNext", thread: "imageNext" },
};

export function resolveAction(command, mode) {
  const byMode = ACTIONS[command];
  if (!byMode) return "noop";
  return byMode[mode] || "noop";
}

// Used only when the browser has focus. The daemon covers another application
// holding focus; this keeps the script usable and testable on its own.
export const KEY_CODES = {
  Numpad0: "toggle",
  NumpadEnter: "open",
  NumpadDecimal: "back",
  NumpadAdd: "faster",
  NumpadSubtract: "slower",
  Numpad8: "prev",
  Numpad2: "next",
  Numpad5: "reverse",
  NumpadMultiply: "help",
  Numpad1: "standby",
  Numpad4: "image_prev",
  Numpad6: "image_next",
};

/**
 * The bindings assumed until the daemon says otherwise. Mirrors
 * DEFAULT_BINDINGS in config.py and the KEY_CODES fallback above, so with the
 * daemon down these are the keys that work.
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
  standby: "numpad1",
  image_prev: "numpad4",
  image_next: "numpad6",
};

export function commandForKeyCode(code) {
  return KEY_CODES[code] || null;
}
