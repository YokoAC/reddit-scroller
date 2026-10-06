/** The on-screen readout, sized to be legible from another monitor. */

import { DEFAULT_BINDINGS } from "./commands.js";
import { HIGHLIGHT_CLASS } from "./selection.js";

export const HUD_ID = "rs-hud";
export const BAR_CELLS = 12;

const STYLE_ID = "rs-style";

// How long after the speed field closes the HUD still counts as editing. The
// daemon's hook is global, so the Enter that confirms a value also arrives as
// a command, a few tens of milliseconds later over the long poll.
const EDIT_GRACE_MS = 500;

const CSS = `
#${HUD_ID} {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483647;
  width: 320px;
  padding: 14px 16px;
  border-radius: 10px;
  background: rgba(16, 16, 20, 0.92);
  color: #f2f2f2;
  font: 500 17px/1.35 "Segoe UI", system-ui, sans-serif;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  user-select: none;
}
#${HUD_ID} .rs-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}
#${HUD_ID} .rs-status { font-weight: 700; letter-spacing: 0.04em; }
#${HUD_ID} .rs-running { color: #56d364; }
#${HUD_ID} .rs-paused { color: #e3b341; }
#${HUD_ID} .rs-online { color: #56d364; font-size: 14px; }
/* Amber, not red: the script is working, it is simply doing it alone. */
#${HUD_ID} .rs-offline { color: #e3b341; font-size: 14px; }
#${HUD_ID} .rs-dormant { color: #8b949e; }
/* Collapsed keeps the first row -- status and daemon -- and drops the
   rest. A dormant script that draws nothing looks like a broken one. */
#${HUD_ID}.rs-collapsed { width: auto; opacity: 0.8; }
#${HUD_ID}.rs-collapsed > *:not(:first-child) { display: none; }
/* The one clickable thing on a panel that otherwise lets every click through. */
#${HUD_ID} .rs-daemon { margin-left: auto; }
#${HUD_ID} .rs-gear {
  pointer-events: auto;
  cursor: pointer;
  padding: 0 2px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 15px;
  line-height: 1;
  opacity: 0.6;
}
#${HUD_ID} .rs-gear:hover, #${HUD_ID} .rs-gear:focus-visible { opacity: 1; }
#${HUD_ID} .rs-speed { pointer-events: auto; cursor: text; }
#${HUD_ID} .rs-speed:hover { text-decoration: underline dotted; }
#${HUD_ID} .rs-speed-input {
  pointer-events: auto;
  width: 96px;
  padding: 0 4px;
  border: 1px solid #58a6ff;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
  font: inherit;
}
#${HUD_ID} .rs-rule {
  height: 1px;
  margin: 9px 0;
  background: rgba(255, 255, 255, 0.16);
}
#${HUD_ID} .rs-bar {
  font-family: "Cascadia Mono", Consolas, monospace;
  letter-spacing: 1px;
  color: #58a6ff;
}
#${HUD_ID} .rs-mode { font-size: 14px; opacity: 0.65; letter-spacing: 0.08em; }
#${HUD_ID} .rs-sub { font-size: 14px; opacity: 0.75; }
#${HUD_ID} .rs-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
#${HUD_ID} .rs-flash { font-size: 14px; color: #58a6ff; min-height: 19px; }
#${HUD_ID} .rs-help {
  margin-top: 9px;
  padding-top: 9px;
  border-top: 1px solid rgba(255, 255, 255, 0.16);
  font-size: 14px;
}
#${HUD_ID} .rs-help-row {
  display: flex;
  gap: 10px;
  padding: 1px 0;
  opacity: 0.85;
}
#${HUD_ID} .rs-help-key {
  flex: 0 0 76px;
  font-family: "Cascadia Mono", Consolas, monospace;
  color: #58a6ff;
}
.${HIGHLIGHT_CLASS} {
  outline: 3px solid #58a6ff !important;
  outline-offset: 2px;
  border-radius: 8px;
}
`;

const KEY_LABELS = {
  numpad0: "Num 0",
  numpad1: "Num 1",
  numpad2: "Num 2",
  numpad3: "Num 3",
  numpad4: "Num 4",
  numpad5: "Num 5",
  numpad6: "Num 6",
  numpad7: "Num 7",
  numpad8: "Num 8",
  numpad9: "Num 9",
  numpad_dot: "Num .",
  numpad_plus: "Num +",
  numpad_minus: "Num −",
  numpad_star: "Num *",
  numpad_slash: "Num /",
  numpad_enter: "Num Enter",
};

// Order the panel reads in, not whatever order the daemon serialised.
export const HELP_ORDER = [
  ["toggle", "pause / resume"],
  ["faster", "speed up (hold to ramp)"],
  ["slower", "slow down (hold to ramp)"],
  ["reverse", "flip scroll direction"],
  ["next", "next post / page down"],
  ["prev", "previous post / page up"],
  ["image_prev", "previous image in a gallery"],
  ["image_next", "next image in a gallery"],
  ["open", "open selected post"],
  ["back", "back to the feed"],
  ["help", "show or hide the key list"],
  ["standby", "switch the script off / on"],
];

/** Turn the daemon's command->key-name map into rows for the help panel. */
export function helpRows(bindings) {
  // With the daemon down we never learn the configured bindings -- and that is
  // exactly when someone is most likely to be looking for this panel. Fall
  // back to the defaults, which are what the in-page key handler uses anyway.
  const source =
    bindings && Object.keys(bindings).length ? bindings : DEFAULT_BINDINGS;
  const rows = [];
  for (const [command, action] of HELP_ORDER) {
    const name = source[command];
    if (!name) continue;
    rows.push({ command, action, key: KEY_LABELS[name] || name });
  }
  return rows;
}

export function formatHud(state) {
  const span = Math.max(1, state.speedMax - state.speedMin);
  const filled = Math.round(
    ((state.speed - state.speedMin) / span) * BAR_CELLS,
  );
  const clamped = Math.min(BAR_CELLS, Math.max(0, filled));

  let subreddit = "";
  let title = "";
  if (state.mode === "feed") {
    if (state.selected) {
      subreddit = state.selected.subreddit;
      title = `\u201C${state.selected.title}\u201D`;
    } else {
      title = state.postCount === 0 ? "no posts detected" : "no post in focus";
    }
  }

  // Standby outranks running: the engine is stopped either way, but
  // "PAUSED" promises the keys still work, and here they do not.
  const status = state.standby
    ? { text: "OFF", cls: "rs-dormant" }
    : state.running
      ? { text: "SCROLLING", cls: "rs-running" }
      : { text: "PAUSED", cls: "rs-paused" };

  return {
    status: status.text,
    statusClass: status.cls,
    collapsed: Boolean(state.standby),
    speed: `${state.direction === -1 ? "▲" : "▼"} ${Math.round(state.speed)} px/s`,
    bar: "▓".repeat(clamped) + "░".repeat(BAR_CELLS - clamped),
    mode: state.mode.toUpperCase(),
    subreddit,
    title,
    // "browser only" rather than "no daemon": every key still works, just
    // not while another window has focus. Naming the mode that is running
    // beats naming the half that is missing, and the amber says degraded
    // rather than broken.
    daemon: state.daemonConnected ? "daemon" : "browser only",
    daemonClass: state.daemonConnected ? "rs-online" : "rs-offline",
    flash: state.lastCommand ? state.lastCommand.toUpperCase() : "",
  };
}

export class Hud {
  constructor(doc, { onSettings, onSpeed } = {}) {
    this._doc = doc;
    this._onSettings = onSettings;
    this._onSpeed = onSpeed;
    this._root = null;
    this._nodes = null;
    this._last = null;
    this._input = null;
    this._editEndedAt = Number.NEGATIVE_INFINITY;
  }

  /** Whether a speed is being typed, or was until a moment ago. */
  get editing() {
    return (
      this._input !== null || Date.now() - this._editEndedAt < EDIT_GRACE_MS
    );
  }

  mount() {
    const existing = this._doc.getElementById(HUD_ID);
    if (existing) {
      // Adopt a panel a previous instance left behind, so render() still works.
      this._root = existing;
      this._nodes = this._collect(existing);
      this._wire(existing);
      return;
    }

    if (!this._doc.getElementById(STYLE_ID)) {
      const style = this._doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      this._doc.head.appendChild(style);
    }

    const root = this._doc.createElement("div");
    root.id = HUD_ID;
    root.innerHTML = `
      <div class="rs-row">
        <span class="rs-status"></span>
        <span class="rs-daemon"></span>
        <button type="button" class="rs-gear" aria-label="Key bindings">⚙</button>
      </div>
      <div class="rs-rule"></div>
      <div class="rs-row">
        <span class="rs-speed"></span>
        <span class="rs-bar"></span>
      </div>
      <div class="rs-mode"></div>
      <div class="rs-sub"></div>
      <div class="rs-title"></div>
      <div class="rs-flash"></div>
      <div class="rs-help" hidden></div>
    `;
    this._doc.body.appendChild(root);
    this._root = root;
    this._nodes = this._collect(root);
    this._wire(root);
  }

  _wire(root) {
    // Optional chaining: a panel adopted from an older version has no gear.
    root
      .querySelector(".rs-gear")
      ?.addEventListener("click", () => this._onSettings?.());
    root
      .querySelector(".rs-speed")
      .addEventListener("click", () => this._editSpeed());
  }

  /** Swap the speed text for a number field until Enter, Escape or blur. */
  _editSpeed() {
    if (this._input || !this._last) return;
    const text = this._nodes.speed;
    const input = this._doc.createElement("input");
    input.type = "number";
    input.className = "rs-speed-input";
    input.min = "1";
    input.max = String(this._last.speedMax);
    input.value = String(Math.round(this._last.speed));
    input.setAttribute("aria-label", "Scroll speed in pixels per second");

    const finish = (commit) => {
      // Removing a focused field fires blur, which would finish it twice.
      if (this._input !== input) return;
      this._input = null;
      this._editEndedAt = Date.now();
      const value = Math.round(Number(input.value));
      input.remove();
      text.hidden = false;
      if (commit && input.value.trim() !== "" && value >= 1) {
        this._onSpeed?.(value);
      }
    };
    input.addEventListener("keydown", (event) => {
      // A digit typed here is not a page shortcut.
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      else if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));

    text.hidden = true;
    text.after(input);
    this._input = input;
    input.focus();
    input.select();
  }

  _collect(root) {
    return {
      status: root.querySelector(".rs-status"),
      daemon: root.querySelector(".rs-daemon"),
      speed: root.querySelector(".rs-speed"),
      bar: root.querySelector(".rs-bar"),
      mode: root.querySelector(".rs-mode"),
      sub: root.querySelector(".rs-sub"),
      title: root.querySelector(".rs-title"),
      flash: root.querySelector(".rs-flash"),
      help: root.querySelector(".rs-help"),
    };
  }

  render(state) {
    if (!this._nodes) return;
    this._last = state;
    const view = formatHud(state);
    const n = this._nodes;
    this._root.classList.toggle("rs-collapsed", view.collapsed);
    n.status.textContent = view.status;
    n.status.className = `rs-status ${view.statusClass}`;
    n.daemon.textContent = `● ${view.daemon}`;
    // Keep the rs-daemon marker: _collect() looks the node up by it, so
    // dropping it here would break a later mount() that adopts this panel.
    n.daemon.className = `rs-daemon ${view.daemonClass}`;
    n.speed.textContent = view.speed;
    n.bar.textContent = view.bar;
    n.mode.textContent = view.mode;
    n.sub.textContent = view.subreddit;
    n.title.textContent = view.title;
    n.flash.textContent = view.flash;
    this._renderHelp(state);
  }

  _renderHelp(state) {
    const node = this._nodes.help;
    if (!node) return;
    node.hidden = !state.helpVisible;
    if (!state.helpVisible) return;

    const rows = helpRows(state.bindings);
    const signature = JSON.stringify(rows);
    if (node.dataset.signature === signature) return; // nothing changed
    node.dataset.signature = signature;

    node.textContent = "";
    for (const row of rows) {
      const line = this._doc.createElement("div");
      line.className = "rs-help-row";
      const key = this._doc.createElement("span");
      key.className = "rs-help-key";
      key.textContent = row.key;
      const action = this._doc.createElement("span");
      action.textContent = row.action;
      line.append(key, action);
      node.appendChild(line);
    }
  }

  unmount() {
    if (this._root?.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
    this._root = null;
    this._nodes = null;
  }
}
