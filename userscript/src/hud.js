/** The on-screen readout, sized to be legible from another monitor. */

import { DEFAULT_BINDINGS } from "./commands.js";
import { HIGHLIGHT_CLASS } from "./selection.js";

export const HUD_ID = "rs-hud";
export const BAR_CELLS = 12;

const STYLE_ID = "rs-style";

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
  numpad_enter: "Num Enter",
};

// Order the panel reads in, not whatever order the daemon serialised.
const HELP_ORDER = [
  ["toggle", "pause / resume"],
  ["faster", "speed up (hold to ramp)"],
  ["slower", "slow down (hold to ramp)"],
  ["reverse", "flip scroll direction"],
  ["next", "next post / page down"],
  ["prev", "previous post / page up"],
  ["open", "open selected post"],
  ["back", "back to the feed"],
  ["help", "show or hide this panel"],
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

  return {
    status: state.running ? "SCROLLING" : "PAUSED",
    statusClass: state.running ? "rs-running" : "rs-paused",
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
  constructor(doc) {
    this._doc = doc;
    this._root = null;
    this._nodes = null;
  }

  mount() {
    const existing = this._doc.getElementById(HUD_ID);
    if (existing) {
      // Adopt a panel a previous instance left behind, so render() still works.
      this._root = existing;
      this._nodes = this._collect(existing);
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
    const view = formatHud(state);
    const n = this._nodes;
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
