// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { assign, fromPreset } from "../src/bindings.js";
import { BindingsPanel, PANEL_ID } from "../src/panel.js";

const ROWS = [
  ["toggle", "pause / resume"],
  ["open", "open selected post"],
];

function setup({ daemon = false, anchor } = {}) {
  const state = { bindings: fromPreset("numpad"), presets: [] };
  const panel = new BindingsPanel(document, {
    rows: ROWS,
    getBindings: () => state.bindings,
    isDaemonConnected: () => daemon,
    anchor,
    onAssign: (command, code, key) => {
      state.bindings = assign(state.bindings, command, code, key);
    },
    onPreset: (name) => {
      state.presets.push(name);
      state.bindings = fromPreset(name);
    },
  });
  return { panel, state };
}

const root = () => document.getElementById(PANEL_ID);
const bindButton = (command) =>
  root().querySelector(`button[data-command="${command}"]`);
const key = (code, k = "") =>
  new KeyboardEvent("keydown", { code, key: k, cancelable: true });

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("BindingsPanel", () => {
  it("is not in the page until shown", () => {
    const { panel } = setup();
    expect(root()).toBeNull();
    expect(panel.open).toBe(false);
  });

  it("lists each action with its current key", () => {
    const { panel } = setup();
    panel.show();
    expect(panel.open).toBe(true);
    expect(root().getAttribute("role")).toBe("dialog");
    expect(bindButton("toggle").textContent).toBe("Num 0");
    expect(root().textContent).toContain("pause / resume");
  });

  it("binds the next key pressed after a row is clicked", () => {
    const { panel, state } = setup();
    panel.show();
    bindButton("toggle").click();
    expect(panel.capturing).toBe("toggle");
    expect(bindButton("toggle").textContent).toMatch(/press a key/i);

    const event = key("Space", " ");
    expect(panel.handleKey(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(state.bindings.toggle.code).toBe("Space");
    expect(panel.capturing).toBeNull();
    expect(bindButton("toggle").textContent).toBe("Space");
  });

  it("shows a command that lost its key as unbound", () => {
    const { panel } = setup();
    panel.show();
    bindButton("toggle").click();
    panel.handleKey(key("NumpadEnter"));
    expect(bindButton("open").textContent).toMatch(/unbound/i);
    // Flagged for styling; the word itself stays, so colour is not the only cue.
    expect(bindButton("open").dataset.unbound).toBe("");
    expect(bindButton("toggle").dataset.unbound).toBeUndefined();
  });

  it("opens just above the element it is anchored to", () => {
    const hud = document.createElement("div");
    hud.getBoundingClientRect = () => ({ top: 500 });
    const { panel } = setup({ anchor: () => hud });
    panel.show();
    // 768 is jsdom's window height: the gap below the panel is everything
    // from the anchor's top edge down, plus a small margin.
    expect(root().style.bottom).toBe("276px");
    expect(root().style.maxHeight).toBe("calc(100vh - 292px)");
  });

  it("sits in the corner when there is nothing to anchor to", () => {
    const { panel } = setup({ anchor: () => null });
    panel.show();
    expect(root().style.bottom).toBe("16px");
  });

  it("cancels a capture on Escape without binding it", () => {
    const { panel, state } = setup();
    panel.show();
    bindButton("toggle").click();
    panel.handleKey(key("Escape", "Escape"));
    expect(panel.capturing).toBeNull();
    expect(panel.open).toBe(true);
    expect(state.bindings.toggle.code).toBe("Numpad0");
  });

  it("does not bind a modifier pressed on its own", () => {
    const { panel, state } = setup();
    panel.show();
    bindButton("toggle").click();
    panel.handleKey(key("ShiftLeft", "Shift"));
    expect(panel.capturing).toBe("toggle");
    expect(state.bindings.toggle.code).toBe("Numpad0");
  });

  it("closes on Escape when not capturing, and on its close button", () => {
    const { panel } = setup();
    panel.show();
    panel.handleKey(key("Escape", "Escape"));
    expect(panel.open).toBe(false);
    panel.show();
    root().querySelector("button[data-close]").click();
    expect(panel.open).toBe(false);
  });

  it("closes from an x in its header, leaving the footer to the presets", () => {
    const { panel } = setup();
    panel.show();
    const close = root().querySelector("button[data-close]");
    expect(close.textContent).toBe("×");
    // The glyph says nothing to a screen reader.
    expect(close.getAttribute("aria-label")).toBe("Close");
    expect(close.closest(".rs-bindings-head")).not.toBeNull();
    expect(root().querySelectorAll(".rs-bindings-foot button")).toHaveLength(2);
  });

  it("swallows other keys while open, so they are not commands", () => {
    const { panel } = setup();
    panel.show();
    expect(panel.handleKey(key("Numpad0"))).toBe(true);
    panel.hide();
    expect(panel.handleKey(key("Numpad0"))).toBe(false);
  });

  it("applies a preset from its button", () => {
    const { panel, state } = setup();
    panel.show();
    root().querySelector('button[data-preset="laptop"]').click();
    expect(state.presets).toEqual(["laptop"]);
    expect(bindButton("toggle").textContent).toBe("Space");
  });

  it("says the daemon's keys are in charge while it is connected", () => {
    const { panel } = setup({ daemon: true });
    panel.show();
    const note = root().querySelector(".rs-bindings-note");
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain("config.json");
  });

  it("hides that note in browser-only mode", () => {
    const { panel } = setup();
    panel.show();
    expect(root().querySelector(".rs-bindings-note").hidden).toBe(true);
  });

  it("toggles", () => {
    const { panel } = setup();
    panel.toggle();
    expect(panel.open).toBe(true);
    panel.toggle();
    expect(panel.open).toBe(false);
    expect(root()).toBeNull();
  });
});
