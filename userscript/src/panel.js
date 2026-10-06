/** The key bindings panel: rebind the page's keys, or load a preset. */

export const PANEL_ID = "rs-bindings";
const STYLE_ID = "rs-bindings-style";

const CSS = `
#${PANEL_ID} {
  position: fixed;
  right: 16px;
  z-index: 2147483647;
  /* border-box, so the padding counts towards the height limit set in _place. */
  box-sizing: border-box;
  width: 460px;
  max-width: calc(100vw - 32px);
  overflow: auto;
  padding: 18px 20px;
  border-radius: 10px;
  background: rgb(16, 16, 20);
  color: #f2f2f2;
  font: 500 15px/1.4 "Segoe UI", system-ui, sans-serif;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6);
}
#${PANEL_ID} h2 { margin: 0 0 10px; font-size: 17px; color: #f2f2f2; }
#${PANEL_ID} .rs-bindings-note { margin: 0 0 10px; font-size: 13px; color: #e3b341; }
#${PANEL_ID} .rs-bindings-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 3px 0;
}
#${PANEL_ID} button {
  font: inherit;
  color: #f2f2f2;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  padding: 3px 10px;
  cursor: pointer;
}
#${PANEL_ID} button:hover, #${PANEL_ID} button:focus-visible { border-color: #58a6ff; }
#${PANEL_ID} button[data-command] {
  min-width: 120px;
  font-family: "Cascadia Mono", Consolas, monospace;
  color: #58a6ff;
}
/* Amber, as on the HUD: nothing is broken, the action just has no key. */
#${PANEL_ID} button[data-unbound] {
  color: #e3b341;
  border-color: rgba(227, 179, 65, 0.5);
}
#${PANEL_ID} .rs-bindings-foot {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.16);
}
#${PANEL_ID} button[data-close] { margin-left: auto; }
`;

const MODIFIER = /^(Shift|Control|Alt|Meta|OS)/;

export class BindingsPanel {
  /**
   * @param rows [command, description] pairs, in display order.
   * The panel holds no bindings itself: it reads them through `getBindings`
   * and reports changes through `onAssign` and `onPreset`.
   */
  constructor(
    doc,
    { rows, getBindings, isDaemonConnected, onAssign, onPreset, anchor },
  ) {
    this._doc = doc;
    this._rows = rows;
    this._getBindings = getBindings;
    this._isDaemonConnected = isDaemonConnected;
    this._onAssign = onAssign;
    this._onPreset = onPreset;
    this._anchor = anchor;
    this._root = null;
    this._capturing = null;
  }

  get open() {
    return this._root !== null;
  }

  /** The command waiting for a key, or null. */
  get capturing() {
    return this._capturing;
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  show() {
    if (this.open) return;
    if (!this._doc.getElementById(STYLE_ID)) {
      const style = this._doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      this._doc.head.appendChild(style);
    }
    const root = this._doc.createElement("div");
    root.id = PANEL_ID;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Key bindings");
    root.addEventListener("click", (event) => this._onClick(event));
    this._place(root);
    this._doc.body.appendChild(root);
    this._root = root;
    this.render();
  }

  // Just above the HUD it was opened from, rather than over the post being
  // read. If it is taller than the room there, it scrolls inside itself.
  _place(root) {
    const anchor = this._anchor?.();
    const view = this._doc.defaultView;
    const gap = anchor
      ? Math.round(view.innerHeight - anchor.getBoundingClientRect().top) + 8
      : 16;
    root.style.bottom = `${gap}px`;
    root.style.maxHeight = `calc(100vh - ${gap + 16}px)`;
  }

  hide() {
    this._root?.remove();
    this._root = null;
    this._capturing = null;
  }

  /**
   * Offer a keydown to the panel. Returns whether it took it: every key while
   * open, so that rebinding never also runs the command being rebound.
   */
  handleKey(event) {
    if (!this.open) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.code === "Escape") {
      if (this._capturing) this._capturing = null;
      else this.hide();
    } else if (this._capturing && !MODIFIER.test(event.code)) {
      this._onAssign(this._capturing, event.code, event.key);
      this._capturing = null;
    }
    this.render();
    return true;
  }

  render() {
    if (!this.open) return;
    const bindings = this._getBindings();
    const root = this._root;
    root.textContent = "";

    const title = this._doc.createElement("h2");
    title.textContent = "Key bindings";

    const note = this._doc.createElement("p");
    note.className = "rs-bindings-note";
    note.textContent =
      "The daemon is connected, so the keys in its config.json are active. " +
      "These apply when it is not running.";
    note.hidden = !this._isDaemonConnected();
    root.append(title, note);

    for (const [command, description] of this._rows) {
      const row = this._doc.createElement("div");
      row.className = "rs-bindings-row";
      const label = this._doc.createElement("span");
      label.textContent = description;
      const button = this._button(
        this._capturing === command
          ? "press a key…"
          : (bindings[command]?.label ?? "unbound"),
        "command",
        command,
      );
      if (!bindings[command] && this._capturing !== command) {
        button.dataset.unbound = "";
      }
      row.append(label, button);
      root.append(row);
    }

    const foot = this._doc.createElement("div");
    foot.className = "rs-bindings-foot";
    foot.append(
      this._button("Numpad (default)", "preset", "numpad"),
      this._button("Laptop", "preset", "laptop"),
      this._button("Close", "close", ""),
    );
    root.append(foot);
  }

  _button(text, dataKey, dataValue) {
    const button = this._doc.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.dataset[dataKey] = dataValue;
    return button;
  }

  _onClick(event) {
    const button = event.target.closest?.("button");
    if (!button) return;
    const { command, preset } = button.dataset;
    if (command) {
      this._capturing = command;
    } else if (preset) {
      this._capturing = null;
      this._onPreset(preset);
    } else {
      this.hide();
      return;
    }
    this.render();
  }
}
