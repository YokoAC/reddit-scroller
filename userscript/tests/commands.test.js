import { describe, expect, it } from "vitest";
import { commandForKeyCode, detectMode, resolveAction } from "../src/commands.js";

describe("detectMode", () => {
  it("calls a comments URL a thread", () => {
    expect(detectMode("/r/buildapc/comments/1abc/is_64gb_overkill/")).toBe(
      "thread",
    );
  });

  it("calls the front page a feed", () => {
    expect(detectMode("/")).toBe("feed");
  });

  it("calls a subreddit listing a feed", () => {
    expect(detectMode("/r/buildapc/")).toBe("feed");
  });

  it("calls a sorted listing a feed", () => {
    expect(detectMode("/r/buildapc/top/?t=week")).toBe("feed");
  });
});

describe("resolveAction", () => {
  it("toggles scrolling in either mode", () => {
    expect(resolveAction("toggle", "feed")).toBe("toggleScroll");
    expect(resolveAction("toggle", "thread")).toBe("toggleScroll");
  });

  it("changes speed in either mode", () => {
    expect(resolveAction("faster", "feed")).toBe("speedUp");
    expect(resolveAction("slower", "thread")).toBe("speedDown");
  });

  it("opens the selected post only in the feed", () => {
    expect(resolveAction("open", "feed")).toBe("openSelected");
    expect(resolveAction("open", "thread")).toBe("noop");
  });

  it("goes back only from a thread", () => {
    expect(resolveAction("back", "thread")).toBe("goBack");
    expect(resolveAction("back", "feed")).toBe("noop");
  });

  it("moves selection in the feed", () => {
    expect(resolveAction("next", "feed")).toBe("selectNext");
    expect(resolveAction("prev", "feed")).toBe("selectPrev");
  });

  it("pages the viewport in a thread", () => {
    expect(resolveAction("next", "thread")).toBe("pageDown");
    expect(resolveAction("prev", "thread")).toBe("pageUp");
  });

  it("ignores an unknown command", () => {
    expect(resolveAction("selfdestruct", "feed")).toBe("noop");
  });
});

describe("commandForKeyCode", () => {
  it("maps every numpad key we bind", () => {
    expect(commandForKeyCode("Numpad0")).toBe("toggle");
    expect(commandForKeyCode("NumpadEnter")).toBe("open");
    expect(commandForKeyCode("NumpadDecimal")).toBe("back");
    expect(commandForKeyCode("NumpadAdd")).toBe("faster");
    expect(commandForKeyCode("NumpadSubtract")).toBe("slower");
    expect(commandForKeyCode("Numpad8")).toBe("prev");
    expect(commandForKeyCode("Numpad2")).toBe("next");
  });

  it("ignores keys we do not bind", () => {
    expect(commandForKeyCode("KeyA")).toBeNull();
    expect(commandForKeyCode("Enter")).toBeNull();
    expect(commandForKeyCode("ArrowDown")).toBeNull();
  });
});

describe("the new commands", () => {
  it("flips direction in either mode", () => {
    expect(resolveAction("reverse", "feed")).toBe("flipDirection");
    expect(resolveAction("reverse", "thread")).toBe("flipDirection");
  });

  it("toggles help in either mode", () => {
    expect(resolveAction("help", "feed")).toBe("toggleHelp");
    expect(resolveAction("help", "thread")).toBe("toggleHelp");
  });

  it("maps their keys for the in-page fallback", () => {
    expect(commandForKeyCode("Numpad5")).toBe("reverse");
    expect(commandForKeyCode("NumpadMultiply")).toBe("help");
  });
});

describe("resolveAction covers every command in both modes", () => {
  // The earlier suite left two cells unasserted; enumerate the whole table so
  // a future command cannot be added to one mode and forgotten in the other.
  const EXPECTED = {
    toggle: ["toggleScroll", "toggleScroll"],
    faster: ["speedUp", "speedUp"],
    slower: ["speedDown", "speedDown"],
    open: ["openSelected", "noop"],
    back: ["noop", "goBack"],
    next: ["selectNext", "pageDown"],
    prev: ["selectPrev", "pageUp"],
    reverse: ["flipDirection", "flipDirection"],
    help: ["toggleHelp", "toggleHelp"],
  };

  it.each(Object.entries(EXPECTED))("%s", (command, [feed, thread]) => {
    expect(resolveAction(command, "feed")).toBe(feed);
    expect(resolveAction(command, "thread")).toBe(thread);
  });
});
