import { describe, expect, it } from "vitest";
import { commandForKeyCode } from "../src/commands.js";
import { BAR_CELLS, formatHud, helpRows } from "../src/hud.js";

// The label the panel should print for each DOM key code the in-page fallback
// handles. The code->command direction is read from commands.js itself.
const CODE_TO_LABEL = {
  Numpad0: "Num 0",
  NumpadEnter: "Num Enter",
  NumpadDecimal: "Num .",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num −",
  Numpad8: "Num 8",
  Numpad2: "Num 2",
  Numpad5: "Num 5",
  NumpadMultiply: "Num *",
};

const BASE = {
  running: true,
  speed: 90,
  speedMin: 15,
  speedMax: 600,
  mode: "feed",
  selected: { title: "Is 64GB overkill?", subreddit: "r/buildapc", score: 412 },
  postCount: 25,
  daemonConnected: true,
  lastCommand: null,
};

describe("formatHud", () => {
  it("shows the running state", () => {
    const out = formatHud(BASE);
    expect(out.status).toBe("SCROLLING");
    expect(out.statusClass).toBe("rs-running");
  });

  it("shows the paused state", () => {
    const out = formatHud({ ...BASE, running: false });
    expect(out.status).toBe("PAUSED");
    expect(out.statusClass).toBe("rs-paused");
  });

  it("renders the speed with units", () => {
    expect(formatHud(BASE).speed).toBe("▼ 90 px/s");
  });

  it("rounds a fractional speed", () => {
    expect(formatHud({ ...BASE, speed: 97.4 }).speed).toBe("▼ 97 px/s");
  });

  it("renders a bar of fixed width", () => {
    expect(formatHud(BASE).bar).toHaveLength(BAR_CELLS);
  });

  it("renders an almost-empty bar at the minimum speed", () => {
    expect(formatHud({ ...BASE, speed: 15 }).bar).toBe("░".repeat(BAR_CELLS));
  });

  it("renders a full bar at the maximum speed", () => {
    expect(formatHud({ ...BASE, speed: 600 }).bar).toBe("▓".repeat(BAR_CELLS));
  });

  it("uppercases the mode", () => {
    expect(formatHud(BASE).mode).toBe("FEED");
    expect(formatHud({ ...BASE, mode: "thread" }).mode).toBe("THREAD");
  });

  it("quotes the selected post's title", () => {
    const out = formatHud(BASE);
    expect(out.subreddit).toBe("r/buildapc");
    expect(out.title).toBe("\u201CIs 64GB overkill?\u201D");
  });

  it("says so when no post is selected but the feed has posts", () => {
    const out = formatHud({ ...BASE, selected: null });
    expect(out.title).toBe("no post in focus");
    expect(out.subreddit).toBe("");
  });

  it("says so when the feed has no posts at all", () => {
    const out = formatHud({ ...BASE, selected: null, postCount: 0 });
    expect(out.title).toBe("no posts detected");
  });

  it("hides post details in thread mode", () => {
    const out = formatHud({ ...BASE, mode: "thread" });
    expect(out.title).toBe("");
    expect(out.subreddit).toBe("");
  });

  it("reports the daemon connection", () => {
    expect(formatHud(BASE).daemon).toBe("daemon");
    expect(formatHud(BASE).daemonClass).toBe("rs-online");
    const off = formatHud({ ...BASE, daemonConnected: false });
    expect(off.daemon).toBe("no daemon");
    expect(off.daemonClass).toBe("rs-offline");
  });

  it("shows the last command, uppercased", () => {
    expect(formatHud({ ...BASE, lastCommand: "faster" }).flash).toBe("FASTER");
    expect(formatHud(BASE).flash).toBe("");
  });
});

describe("direction", () => {
  it("shows a down arrow with the speed by default", () => {
    expect(formatHud({ ...BASE, direction: 1 }).speed).toBe("▼ 90 px/s");
  });

  it("shows an up arrow when reversed", () => {
    expect(formatHud({ ...BASE, direction: -1 }).speed).toBe("▲ 90 px/s");
  });

  it("treats a missing direction as downward", () => {
    expect(formatHud(BASE).speed).toBe("▼ 90 px/s");
  });
});

describe("helpRows", () => {
  const BINDINGS = {
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

  it("renders a friendly label for every key name", () => {
    const rows = helpRows(BINDINGS);
    const byAction = Object.fromEntries(rows.map((r) => [r.command, r.key]));
    expect(byAction.toggle).toBe("Num 0");
    expect(byAction.open).toBe("Num Enter");
    expect(byAction.back).toBe("Num .");
    expect(byAction.faster).toBe("Num +");
    expect(byAction.slower).toBe("Num −");
    expect(byAction.reverse).toBe("Num 5");
    expect(byAction.help).toBe("Num *");
  });

  it("describes what each command does", () => {
    const rows = helpRows(BINDINGS);
    const byCommand = Object.fromEntries(
      rows.map((r) => [r.command, r.action]),
    );
    expect(byCommand.toggle).toMatch(/pause/i);
    expect(byCommand.faster).toMatch(/hold/i); // the ramp is worth advertising
    expect(byCommand.reverse).toMatch(/direction/i);
  });

  it("reflects a rebound key rather than the default", () => {
    const rows = helpRows({ ...BINDINGS, reverse: "numpad9" });
    expect(rows.find((r) => r.command === "reverse").key).toBe("Num 9");
  });

  it("keeps a stable order regardless of object key order", () => {
    const shuffled = Object.fromEntries(Object.entries(BINDINGS).reverse());
    expect(helpRows(shuffled).map((r) => r.command)).toEqual(
      helpRows(BINDINGS).map((r) => r.command),
    );
  });

  it("skips commands with no binding", () => {
    const rows = helpRows({ toggle: "numpad0" });
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toBe("toggle");
  });

  it("falls back to the raw name for an unknown key", () => {
    expect(helpRows({ toggle: "f13" })[0].key).toBe("f13");
  });
});

describe("helpRows without a daemon", () => {
  it("falls back to the built-in defaults rather than showing nothing", () => {
    // A dead daemon never reports bindings, and that is precisely when a
    // user reaches for the cheat sheet.
    const rows = helpRows(undefined);
    expect(rows.length).toBeGreaterThan(0);
    const byCommand = Object.fromEntries(rows.map((r) => [r.command, r.key]));
    expect(byCommand.toggle).toBe("Num 0");
    expect(byCommand.help).toBe("Num *");
  });

  it("treats an empty bindings object the same as none", () => {
    expect(helpRows({}).length).toBe(helpRows(undefined).length);
  });

  it("still prefers the daemon's bindings when it has them", () => {
    const rows = helpRows({ toggle: "numpad9" });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("Num 9");
  });

  it("advertises the same keys the in-page fallback actually handles", () => {
    // If these drift apart the panel lies to anyone running without a daemon.
    // commandForKeyCode is the real fallback map, so this asserts against the
    // shipped behaviour rather than a copy of it.
    const shown = Object.fromEntries(
      helpRows(undefined).map((r) => [r.command, r.key]),
    );
    for (const [code, label] of Object.entries(CODE_TO_LABEL)) {
      const command = commandForKeyCode(code);
      expect(command).not.toBeNull();
      expect(shown[command]).toBe(label);
    }
    // and every advertised command must be reachable by some fallback key
    expect(Object.keys(shown).sort()).toEqual(
      Object.values(CODE_TO_LABEL)
        .map((_, i) => commandForKeyCode(Object.keys(CODE_TO_LABEL)[i]))
        .sort(),
    );
  });
});
