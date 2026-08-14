import { describe, expect, it } from "vitest";
import { BAR_CELLS, formatHud } from "../src/hud.js";

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
    expect(formatHud(BASE).speed).toBe("90 px/s");
  });

  it("rounds a fractional speed", () => {
    expect(formatHud({ ...BASE, speed: 97.4 }).speed).toBe("97 px/s");
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
