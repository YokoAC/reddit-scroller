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
