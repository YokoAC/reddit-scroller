import { describe, expect, it } from "vitest";
import {
  assign,
  commandFor,
  fromPreset,
  labelFor,
  labelsOf,
  PRESETS,
  parseStored,
} from "../src/bindings.js";
import { commandForKeyCode, DEFAULT_BINDINGS } from "../src/commands.js";

const COMMANDS = Object.keys(DEFAULT_BINDINGS).sort();

describe("presets", () => {
  it.each(["numpad", "laptop"])(
    "%s binds every command to its own key",
    (name) => {
      const codes = Object.values(PRESETS[name]);
      expect(Object.keys(PRESETS[name]).sort()).toEqual(COMMANDS);
      expect(new Set(codes).size).toBe(codes.length);
    },
  );

  it("numpad is the map the script has always used", () => {
    for (const [command, code] of Object.entries(PRESETS.numpad)) {
      expect(commandForKeyCode(code)).toBe(command);
    }
  });

  it("laptop uses no numpad key, and none that moves between QWERTY and QWERTZ", () => {
    for (const code of Object.values(PRESETS.laptop)) {
      expect(code).not.toMatch(/^Numpad/);
      expect(["KeyY", "KeyZ"]).not.toContain(code);
    }
  });
});

describe("labelFor", () => {
  it("names the numpad keys the way the help panel always has", () => {
    expect(labelFor("Numpad0")).toBe("Num 0");
    expect(labelFor("NumpadSubtract")).toBe("Num −");
    expect(labelFor("NumpadEnter")).toBe("Num Enter");
  });

  it("names keys that print nothing", () => {
    expect(labelFor("Space")).toBe("Space");
    expect(labelFor("ArrowUp")).toBe("↑");
    expect(labelFor("Backspace")).toBe("Backspace");
  });

  it("prefers the character the user actually pressed", () => {
    // Physical BracketLeft types "ü" on a German keyboard.
    expect(labelFor("BracketLeft", "ü")).toBe("Ü");
  });

  it("falls back to the letter, then the raw code", () => {
    expect(labelFor("KeyF")).toBe("F");
    expect(labelFor("Digit7")).toBe("7");
    expect(labelFor("F13")).toBe("F13");
  });
});

describe("parseStored", () => {
  const numpad = fromPreset("numpad");

  it("gives the numpad preset when nothing is stored", () => {
    expect(parseStored(undefined)).toEqual(numpad);
    expect(parseStored("")).toEqual(numpad);
  });

  it("keeps a stored binding and an explicit unbinding", () => {
    const parsed = parseStored({
      toggle: { code: "Space", label: "Space" },
      open: null,
    });
    expect(parsed.toggle).toEqual({ code: "Space", label: "Space" });
    expect(parsed.open).toBeNull();
    expect(parsed.back).toEqual(numpad.back);
  });

  it("accepts the JSON string a value editor hands back", () => {
    const parsed = parseStored('{"toggle":{"code":"Space","label":"Space"}}');
    expect(parsed.toggle.code).toBe("Space");
  });

  it("falls back per command on anything malformed", () => {
    const parsed = parseStored({
      toggle: "Space",
      open: { code: 42 },
      nonsense: { code: "KeyQ", label: "Q" },
    });
    expect(parsed.toggle).toEqual(numpad.toggle);
    expect(parsed.open).toEqual(numpad.open);
    expect(parsed).not.toHaveProperty("nonsense");
  });

  it("survives input that is not an object at all", () => {
    for (const junk of ["{not json", 7, [], "null"]) {
      expect(parseStored(junk)).toEqual(numpad);
    }
  });

  it("unbinds the later of two commands stored on one key", () => {
    const parsed = parseStored({
      toggle: { code: "KeyF", label: "F" },
      faster: { code: "KeyF", label: "F" },
    });
    const onF = COMMANDS.filter((c) => parsed[c]?.code === "KeyF");
    expect(onF).toHaveLength(1);
  });
});

describe("assign", () => {
  it("binds the key and labels it", () => {
    const next = assign(fromPreset("numpad"), "toggle", "Space", " ");
    expect(next.toggle).toEqual({ code: "Space", label: "Space" });
  });

  it("takes the key from the command that had it", () => {
    const start = fromPreset("numpad");
    const next = assign(start, "toggle", start.open.code);
    expect(next.toggle.code).toBe(start.open.code);
    expect(next.open).toBeNull();
  });

  it("does not modify its input", () => {
    const start = fromPreset("numpad");
    const copy = structuredClone(start);
    assign(start, "toggle", "Space");
    expect(start).toEqual(copy);
  });
});

describe("lookups", () => {
  const bindings = assign(fromPreset("numpad"), "open", "Numpad0");

  it("finds the command for a key, and nothing for a free one", () => {
    expect(commandFor(bindings, "Numpad0")).toBe("open");
    expect(commandFor(bindings, "KeyQ")).toBeNull();
  });

  it("lists labels for the help panel, leaving unbound commands out", () => {
    const labels = labelsOf(bindings);
    expect(labels.open).toBe("Num 0");
    expect(labels).not.toHaveProperty("toggle");
  });
});
