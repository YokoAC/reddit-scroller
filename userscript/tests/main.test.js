/**
 * Tests for main.js -- the assembly layer.
 *
 * Every module main.js wires together is thoroughly covered and has
 * produced almost no defects. main.js had none, and shipped four of the bugs
 * that reached the user: an empty help panel, every keypress firing twice,
 * a page that resumed scrolling on its own, and a configured default_speed
 * that never applied. This file exists to close that gap.
 *
 * main.js exports nothing and runs on import, so it is exercised the only way
 * it can be: bundled from source with esbuild, then evaluated inside a fresh
 * jsdom window per test with the browser and userscript-manager APIs stubbed.
 * Bundling from src rather than reading dist/ means this can never pass
 * against a stale build.
 */

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { BUILD_TARGET } from "../build-target.js";

let BUNDLE;

beforeAll(async () => {
  const result = await build({
    entryPoints: ["src/main.js"],
    bundle: true,
    format: "iife",
    target: BUILD_TARGET,
    write: false,
  });
  BUNDLE = result.outputFiles[0].text;
}, 30000);

// Permalinks are hash-form on purpose. jsdom's window.location is unforgeable
// -- it cannot be replaced or spied on -- and jsdom refuses real navigation.
// It does implement hash changes, so a hash permalink makes the destination
// observable. The code under test only assigns the attribute's value to
// location.href, so the path it exercises is identical.
const POSTS = [
  { permalink: "#/r/a/comments/1/one/", title: "First", sub: "r/a", score: 10 },
  {
    permalink: "#/r/b/comments/2/two/",
    title: "Second",
    sub: "r/b",
    score: 20,
  },
  {
    permalink: "#/r/c/comments/3/three/",
    title: "Third",
    sub: "r/c",
    score: 30,
  },
];

const SETTINGS = {
  speed_min: 15,
  speed_max: 600,
  speed_step: 15,
  default_speed: 90,
  focus_line: 0.25,
  bindings: {
    toggle: "numpad0",
    open: "numpad_enter",
    back: "numpad_dot",
    faster: "numpad_plus",
    slower: "numpad_minus",
    prev: "numpad8",
    next: "numpad2",
    reverse: "numpad5",
    help: "numpad_star",
  },
};

function feedHtml() {
  const posts = POSTS.map(
    (p) =>
      `<shreddit-post permalink="${p.permalink}" post-title="${p.title}" ` +
      `subreddit-prefixed-name="${p.sub}" score="${p.score}"></shreddit-post>`,
  ).join("");
  return `<!doctype html><html><head></head><body>${posts}</body></html>`;
}

/** A loaded page: fresh window, stubbed APIs, the real bundle running in it. */
class Page {
  static async open({
    url = "https://www.reddit.com/",
    daemonUp = true,
    settings = SETTINGS,
    session = null,
    hidden = false,
  } = {}) {
    const page = new Page();
    // runScripts: "outside-only" gives the window a real eval running in its
    // own context; without it window.eval is Node's and the bundle sees no DOM.
    // pretendToBeVisual supplies requestAnimationFrame.
    const dom = new JSDOM(feedHtml(), {
      url,
      pretendToBeVisual: true,
      runScripts: "outside-only",
    });
    const { window } = dom;
    page.dom = dom;
    page.window = window;
    page.scrolled = [];
    page.wentBack = false;
    page.posted = [];
    page._pending = [];
    page._seq = 0;

    // jsdom has no layout engine, so rects must be supplied: 400px tall posts
    // stacked from the top of a 1000px viewport.
    window.innerHeight = 1000;
    window.document.querySelectorAll("shreddit-post").forEach((el, i) => {
      el.getBoundingClientRect = () => ({
        top: i * 400,
        bottom: i * 400 + 400,
        left: 0,
        right: 800,
        width: 800,
        height: 400,
      });
      el.scrollIntoView = () => {};
    });

    if (session) window.sessionStorage.setItem("rs-scroll-state", session);
    if (hidden) {
      Object.defineProperty(window.document, "hidden", { get: () => true });
    }

    // jsdom does not implement scrolling.
    window.scrollBy = (_x, y) => page.scrolled.push(y);
    window.scrollTo = () => {};
    Object.defineProperty(window, "scrollY", { get: () => 0 });
    window.history.back = () => {
      page.wentBack = true;
    };

    window.GM_xmlhttpRequest = (opts) => {
      const respond = (status, text) =>
        setTimeout(() => opts.onload({ status, responseText: text }), 1);
      if (!daemonUp) return setTimeout(() => opts.onerror({}), 1);
      if (opts.url.includes("/health")) {
        return respond(
          200,
          JSON.stringify({ ok: true, settings, cursor: page._seq }),
        );
      }
      if (opts.url.includes("/events")) {
        // Model the real long poll: hold briefly for a command, then return
        // an empty list. Holding forever would mean the transport never
        // reported a successful poll, so the page would never see the
        // connection come up or adopt any settings.
        const startedAt = Date.now();
        const deliver = () => {
          const events = page._pending.splice(0).map((command) => ({
            seq: ++page._seq,
            command,
          }));
          if (events.length || Date.now() - startedAt > 40) {
            opts.onload({
              status: 200,
              responseText: JSON.stringify({ cursor: page._seq, events }),
            });
          } else {
            setTimeout(deliver, 5);
          }
        };
        return setTimeout(deliver, 5);
      }
      if (opts.url.includes("/state")) {
        page.posted.push(JSON.parse(opts.data));
        return respond(200, '{"ok":true}');
      }
      return respond(404, "");
    };

    window.eval(BUNDLE);
    // Wait on observable state rather than a fixed sleep: the boot sequence is
    // /health, then a poll that holds, then the connection edge and the
    // settings adoption that follows it. A fixed delay races all of that.
    await page.waitForDaemon(daemonUp);
    return page;
  }

  async waitForDaemon(connected, timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const text = this.hud(".rs-daemon");
      if (text && !text.includes("browser only") === connected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `page never reached daemon-${connected ? "up" : "down"}; ` +
        `HUD reads ${JSON.stringify(this.hud(".rs-daemon"))}`,
    );
  }

  /** Deliver a command the way the daemon would. */
  async send(...commands) {
    this._pending.push(...commands);
    await this.settle();
  }

  /** Press a key in the page itself, as the in-page fallback sees it. */
  async press(code, target) {
    const event = new this.window.KeyboardEvent("keydown", {
      code,
      bubbles: true,
    });
    if (target) Object.defineProperty(event, "target", { value: target });
    this.window.dispatchEvent(event);
    await this.settle();
  }

  /** Let timers, the poll loop and the rAF-coalesced repaint catch up. */
  async settle(ms = 60) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  hud(selector) {
    const node = this.window.document.querySelector(`#rs-hud ${selector}`);
    return node ? node.textContent : null;
  }

  /** Where the page navigated, observable because permalinks are hash-form. */
  get navigatedTo() {
    return this.window.location.hash || null;
  }

  get selectedTitle() {
    const el = this.window.document.querySelector(".rs-selected");
    return el ? el.getAttribute("post-title") : null;
  }

  get storedSpeed() {
    const raw = this.window.sessionStorage.getItem("rs-scroll-state");
    return raw ? JSON.parse(raw).speed : null;
  }

  close() {
    this.window.close();
  }
}

let page;

afterEach(() => {
  page?.close();
  page = null;
});

describe("booting on a feed", () => {
  it("mounts the HUD and reports the feed state", async () => {
    page = await Page.open();
    expect(page.hud(".rs-status")).toBe("PAUSED");
    expect(page.hud(".rs-speed")).toBe("▼ 90 px/s");
    expect(page.hud(".rs-mode")).toBe("FEED");
  });

  it("selects the post nearest the focus line and outlines it", async () => {
    page = await Page.open();
    // Focus line is 250; post tops are 0, 400, 800 -- 400 is nearest.
    expect(page.selectedTitle).toBe("Second");
    expect(page.hud(".rs-sub")).toBe("r/b");
  });

  it("reports the daemon connection once polling succeeds", async () => {
    page = await Page.open();
    expect(page.hud(".rs-daemon")).toContain("daemon");
    expect(page.hud(".rs-daemon")).not.toContain("browser only");
  });

  it("says so when the daemon is unreachable", async () => {
    page = await Page.open({ daemonUp: false });
    expect(page.hud(".rs-daemon")).toContain("browser only");
  });

  it("detects thread mode from the URL", async () => {
    page = await Page.open({
      url: "https://www.reddit.com/r/a/comments/1/one/",
    });
    expect(page.hud(".rs-mode")).toBe("THREAD");
  });
});

describe("commands from the daemon", () => {
  it("toggles scrolling and actually scrolls", async () => {
    page = await Page.open();
    await page.send("toggle");
    expect(page.hud(".rs-status")).toBe("SCROLLING");
    await page.settle(120);
    expect(page.scrolled.length).toBeGreaterThan(0);
    expect(page.scrolled.every((d) => d > 0)).toBe(true);
  });

  it("changes speed", async () => {
    page = await Page.open();
    await page.send("faster", "faster");
    expect(page.hud(".rs-speed")).toBe("▼ 120 px/s");
    await page.send("slower");
    expect(page.hud(".rs-speed")).toBe("▼ 105 px/s");
  });

  it("flips direction and scrolls upward", async () => {
    page = await Page.open();
    await page.send("reverse", "toggle");
    expect(page.hud(".rs-speed")).toBe("▲ 90 px/s");
    await page.settle(120);
    expect(page.scrolled.every((d) => d < 0)).toBe(true);
  });

  it("moves the selection with next and prev", async () => {
    page = await Page.open();
    await page.send("next");
    expect(page.selectedTitle).toBe("Third");
    await page.send("prev");
    expect(page.selectedTitle).toBe("Second");
  });

  it("opens the selected post's permalink", async () => {
    page = await Page.open();
    await page.send("open");
    expect(page.navigatedTo).toBe("#/r/b/comments/2/two/");
  });

  it("goes back only from a thread", async () => {
    page = await Page.open();
    await page.send("back");
    expect(page.wentBack).toBe(false);

    page.close();
    page = await Page.open({
      url: "https://www.reddit.com/r/b/comments/2/two/",
    });
    await page.send("back");
    expect(page.wentBack).toBe(true);
  });

  it("ignores an unknown command instead of throwing", async () => {
    page = await Page.open();
    await page.send("selfdestruct");
    expect(page.hud(".rs-status")).toBe("PAUSED");
  });
});

describe("navigation always lands paused", () => {
  it("stops scrolling before opening a thread", async () => {
    page = await Page.open();
    await page.send("toggle");
    expect(page.hud(".rs-status")).toBe("SCROLLING");

    await page.send("open");
    // Persisting alone would not be enough: the back-forward cache can restore
    // a page without re-running the script, so the engine must stop too.
    expect(page.hud(".rs-status")).toBe("PAUSED");
    expect(
      JSON.parse(page.window.sessionStorage.getItem("rs-scroll-state")),
    ).not.toHaveProperty("running", true);
  });

  it("stops scrolling before going back", async () => {
    page = await Page.open({
      url: "https://www.reddit.com/r/b/comments/2/two/",
    });
    await page.send("toggle");
    await page.send("back");
    expect(page.hud(".rs-status")).toBe("PAUSED");
  });
});

describe("persistence", () => {
  it("remembers speed for the tab", async () => {
    page = await Page.open();
    await page.send("faster");
    expect(page.storedSpeed).toBe(105);
  });

  it("never records that it was scrolling", async () => {
    page = await Page.open();
    await page.send("toggle");
    const stored = JSON.parse(
      page.window.sessionStorage.getItem("rs-scroll-state"),
    );
    expect(stored.running).toBeUndefined();
  });

  it("restores a remembered speed instead of the daemon default", async () => {
    page = await Page.open({ session: JSON.stringify({ speed: 300 }) });
    expect(page.hud(".rs-speed")).toBe("▼ 300 px/s");
  });

  it("never resumes scrolling on load, whatever is stored", async () => {
    page = await Page.open({
      session: JSON.stringify({ speed: 300, running: true }),
    });
    expect(page.hud(".rs-status")).toBe("PAUSED");
    await page.settle(120);
    expect(page.scrolled).toEqual([]);
  });

  it("adopts the daemon's default_speed on a fresh tab", async () => {
    page = await Page.open({
      settings: { ...SETTINGS, default_speed: 210 },
    });
    expect(page.hud(".rs-speed")).toBe("▼ 210 px/s");
  });

  it("does not let a reconnect overwrite a speed the user just set", async () => {
    page = await Page.open({ settings: { ...SETTINGS, default_speed: 210 } });
    await page.send("faster");
    expect(page.hud(".rs-speed")).toBe("▼ 225 px/s");
    await page.settle(150); // further polls and any reconnect
    expect(page.hud(".rs-speed")).toBe("▼ 225 px/s");
  });
});

describe("daemon settings are adopted", () => {
  it("applies configured speed limits, not the built-in ones", async () => {
    page = await Page.open({
      settings: { ...SETTINGS, speed_min: 200, speed_max: 400 },
    });
    // 90 is below the configured minimum and must be clamped up to it.
    expect(page.hud(".rs-speed")).toBe("▼ 200 px/s");
  });

  it("applies the configured focus line to selection", async () => {
    page = await Page.open({ settings: { ...SETTINGS, focus_line: 0.85 } });
    // Focus line 850; tops are 0, 400, 800 -- 800 is nearest now.
    expect(page.selectedTitle).toBe("Third");
  });

  it("applies the configured speed step", async () => {
    page = await Page.open({ settings: { ...SETTINGS, speed_step: 50 } });
    await page.send("faster");
    expect(page.hud(".rs-speed")).toBe("▼ 140 px/s");
  });
});

describe("the help panel", () => {
  it("appears by itself once the daemon connects", async () => {
    page = await Page.open();
    const help = page.window.document.querySelector("#rs-hud .rs-help");
    expect(help.hidden).toBe(false);
  });

  it("lists the daemon's bindings", async () => {
    page = await Page.open();
    const help = page.window.document.querySelector("#rs-hud .rs-help");
    expect(help.textContent).toContain("Num 0");
    expect(help.textContent).toContain("pause / resume");
  });

  it("does not auto-appear with no daemon to report bindings", async () => {
    page = await Page.open({ daemonUp: false });
    expect(page.window.document.querySelector("#rs-hud .rs-help").hidden).toBe(
      true,
    );
  });

  it("shows a rebound key rather than the default", async () => {
    page = await Page.open({
      settings: {
        ...SETTINGS,
        bindings: { ...SETTINGS.bindings, reverse: "numpad9" },
      },
    });
    const help = page.window.document.querySelector("#rs-hud .rs-help");
    expect(help.textContent).toContain("Num 9");
  });

  it("falls back to defaults with no daemon", async () => {
    // The bug that reached the user: the panel opened completely empty,
    // which is exactly when a cheat sheet is most wanted.
    page = await Page.open({ daemonUp: false });
    await page.press("NumpadMultiply");
    const help = page.window.document.querySelector("#rs-hud .rs-help");
    expect(help.hidden).toBe(false);
    expect(help.querySelectorAll(".rs-help-row").length).toBeGreaterThan(0);
    expect(help.textContent).toContain("Num 0");
  });

  it("toggles closed, then open again", async () => {
    page = await Page.open();
    const help = page.window.document.querySelector("#rs-hud .rs-help");
    // It is already showing from the auto-show, so the first press closes it.
    await page.send("help");
    expect(help.hidden).toBe(true);
    await page.send("help");
    expect(help.hidden).toBe(false);
  });
});

describe("the in-page key fallback", () => {
  it("handles keys when the daemon is unreachable", async () => {
    page = await Page.open({ daemonUp: false });
    await page.press("Numpad0");
    expect(page.hud(".rs-status")).toBe("SCROLLING");
  });

  it("stays out of the way when the daemon is connected", async () => {
    // Otherwise one physical press fires twice -- the global hook delivers it
    // and so does this listener -- and toggle cancels itself out.
    page = await Page.open();
    await page.press("Numpad0");
    expect(page.hud(".rs-status")).toBe("PAUSED");
  });

  it("ignores numpad keys typed into an input", async () => {
    page = await Page.open({ daemonUp: false });
    const input = page.window.document.createElement("input");
    page.window.document.body.appendChild(input);
    await page.press("Numpad0", input);
    expect(page.hud(".rs-status")).toBe("PAUSED");
  });

  it("ignores keys typed into a contenteditable", async () => {
    page = await Page.open({ daemonUp: false });
    const div = page.window.document.createElement("div");
    Object.defineProperty(div, "isContentEditable", { value: true });
    page.window.document.body.appendChild(div);
    await page.press("Numpad0", div);
    expect(page.hud(".rs-status")).toBe("PAUSED");
  });

  it("ignores keys it has no binding for", async () => {
    page = await Page.open({ daemonUp: false });
    await page.press("KeyA");
    expect(page.hud(".rs-status")).toBe("PAUSED");
  });
});

describe("a hidden tab", () => {
  it("ignores commands aimed at the visible one", async () => {
    // Every tab polls the same log and receives every command.
    page = await Page.open({ hidden: true });
    await page.send("toggle");
    expect(page.hud(".rs-status")).toBe("PAUSED");
  });
});

describe("state reporting", () => {
  it("posts a snapshot the daemon can read", async () => {
    page = await Page.open();
    await page.settle(1100); // the reporting interval
    expect(page.posted.length).toBeGreaterThan(0);
    expect(page.posted.at(-1)).toMatchObject({
      running: false,
      speed: 90,
      mode: "feed",
    });
  });
});

describe("a feed with no posts", () => {
  it("still scrolls and says so in the HUD", async () => {
    page = await Page.open();
    page.window.document.querySelectorAll("shreddit-post").forEach((el) => {
      el.remove();
    });
    await page.send("toggle");
    await page.settle(120);
    expect(page.hud(".rs-status")).toBe("SCROLLING");
    expect(page.hud(".rs-title")).toBe("no posts detected");
  });

  it("treats open as a no-op rather than throwing", async () => {
    page = await Page.open();
    page.window.document.querySelectorAll("shreddit-post").forEach((el) => {
      el.remove();
    });
    // Let the page notice they are gone. Without this the selection still
    // holds the last post it saw, and opening that permalink is correct --
    // Reddit recycles feed nodes, so a vanished element does not mean a
    // vanished post.
    page.window.dispatchEvent(new page.window.Event("scroll"));
    await page.settle();

    await page.send("open");
    expect(page.navigatedTo).toBeNull();
  });
});
