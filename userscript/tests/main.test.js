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
    standby: "numpad1",
    image_prev: "numpad4",
    image_next: "numpad6",
  },
};

// The daemon's default keys, as it reports them on /health.
const NUMPAD_CODES = {
  toggle: "Numpad0",
  open: "NumpadEnter",
  back: "NumpadDecimal",
  faster: "NumpadAdd",
  slower: "NumpadSubtract",
  prev: "Numpad8",
  next: "Numpad2",
  reverse: "Numpad5",
  help: "NumpadMultiply",
  standby: "Numpad1",
  image_prev: "Numpad4",
  image_next: "Numpad6",
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
    stored = {},
    // false: a daemon from before POST /bindings, which keeps its own keys.
    // true, or a list of commands whose key it cannot hook: a current one.
    daemonKeys = false,
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
    page.stored = { ...stored };
    page.urls = [];

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

    window.GM_getValue = (key, fallback) =>
      key in page.stored ? page.stored[key] : fallback;
    window.GM_setValue = (key, value) => {
      page.stored[key] = value;
    };
    page.sentBindings = [];
    page.menu = {};
    window.GM_registerMenuCommand = (name, run) => {
      page.menu[name] = run;
    };

    window.GM_xmlhttpRequest = (opts) => {
      page.urls.push(opts.url);
      const respond = (status, text) =>
        setTimeout(() => opts.onload({ status, responseText: text }), 1);
      if (!daemonUp) return setTimeout(() => opts.onerror({}), 1);
      if (opts.url.includes("/health")) {
        const reported = daemonKeys
          ? { binding_codes: NUMPAD_CODES, ...settings }
          : settings;
        return respond(
          200,
          JSON.stringify({ ok: true, settings: reported, cursor: page._seq }),
        );
      }
      if (opts.url.includes("/bindings")) {
        if (!daemonKeys) return respond(404, "");
        page.sentBindings.push(JSON.parse(opts.data).bindings);
        const unsupported = Array.isArray(daemonKeys) ? daemonKeys : [];
        return respond(200, JSON.stringify({ ok: true, unsupported }));
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
    // On the element itself, so the event really travels up from it: the
    // handler reads the composed path, which a faked `target` would not have.
    (target ?? this.window).dispatchEvent(event);
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

describe("the port", () => {
  it("defaults to 8765 and seeds the value so it can be found", async () => {
    page = await Page.open();
    expect(page.urls.every((u) => u.startsWith("http://127.0.0.1:8765/"))).toBe(
      true,
    );
    // Seeded rather than left absent: a reader looking for somewhere to change
    // the port has to be able to see the key in their manager.
    expect(page.stored["rs-port"]).toBe(8765);
  });

  it("uses a port stored by the manager, with no rebuild", async () => {
    // The whole point: moving the daemon off 8765 used to mean editing
    // main.js, running npm and reinstalling the script.
    page = await Page.open({ stored: { "rs-port": 9123 } });
    expect(page.urls.length).toBeGreaterThan(0);
    expect(page.urls.every((u) => u.startsWith("http://127.0.0.1:9123/"))).toBe(
      true,
    );
  });

  it("accepts the string a value editor hands back", async () => {
    page = await Page.open({ stored: { "rs-port": "9123" } });
    expect(page.urls.every((u) => u.startsWith("http://127.0.0.1:9123/"))).toBe(
      true,
    );
  });

  it("falls back to the default when the stored value is unusable", async () => {
    // A typo must not leave the script unable to reach a daemon running
    // perfectly well on 8765.
    page = await Page.open({ stored: { "rs-port": "not a port" } });
    expect(page.urls.every((u) => u.startsWith("http://127.0.0.1:8765/"))).toBe(
      true,
    );
  });
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
    // To the next multiple of the step, then on by whole steps.
    await page.send("faster");
    expect(page.hud(".rs-speed")).toBe("▼ 100 px/s");
    await page.send("faster");
    expect(page.hud(".rs-speed")).toBe("▼ 150 px/s");
  });
});

describe("standby", () => {
  it("ignores commands until it is woken", async () => {
    page = await Page.open();
    await page.send("standby");
    expect(page.hud(".rs-status")).toBe("OFF");
    await page.send("toggle");
    expect(page.hud(".rs-status")).toBe("OFF");
    await page.settle(120);
    expect(page.scrolled).toEqual([]);
  });

  it("stops a scroll that is already running", async () => {
    page = await Page.open();
    await page.send("toggle");
    await page.settle(120);
    expect(page.scrolled.length).toBeGreaterThan(0);
    await page.send("standby");
    page.scrolled = [];
    await page.settle(120);
    expect(page.scrolled).toEqual([]);
  });

  it("takes the outline off the page", async () => {
    page = await Page.open();
    expect(page.selectedTitle).not.toBeNull();
    await page.send("standby");
    expect(page.selectedTitle).toBeNull();
  });

  it("comes back on a second press, outline and all", async () => {
    page = await Page.open();
    await page.send("standby");
    expect(page.selectedTitle).toBeNull();
    await page.send("standby");
    expect(page.selectedTitle).not.toBeNull();
    await page.send("toggle");
    expect(page.hud(".rs-status")).toBe("SCROLLING");
  });

  it("still opens the help panel, which is where the wake key is written", async () => {
    page = await Page.open();
    const help = page.window.document.querySelector("#rs-hud .rs-help");
    await page.send("help"); // close the panel the daemon connection opened
    expect(help.hidden).toBe(true);
    await page.send("standby");
    expect(page.hud(".rs-status")).toBe("OFF");
    await page.send("help");
    expect(help.hidden).toBe(false);
    expect(help.textContent).toContain("Num 1");
  });

  it("remembers itself where the manager can show it", async () => {
    page = await Page.open();
    await page.send("standby");
    expect(page.stored["rs-standby"]).toBe(true);
    await page.send("standby");
    expect(page.stored["rs-standby"]).toBe(false);
  });

  it("boots dormant when the stored value says so", async () => {
    page = await Page.open({ stored: { "rs-standby": true } });
    expect(page.hud(".rs-status")).toBe("OFF");
    expect(page.selectedTitle).toBeNull();
    await page.send("toggle");
    await page.settle(120);
    expect(page.scrolled).toEqual([]);
  });

  it("does not pop the help panel open when it boots dormant", async () => {
    // The auto-show is a greeting. A script that was switched off should not
    // greet anyone -- that is the exact behaviour standby promises to stop.
    page = await Page.open({ stored: { "rs-standby": true } });
    expect(page.window.document.querySelector("#rs-hud .rs-help").hidden).toBe(
      true,
    );
  });
});

describe("gallery keys", () => {
  /** Give every post Reddit's carousel buttons; return click counts by title. */
  function addGalleries(page) {
    const counts = {};
    for (const post of page.window.document.querySelectorAll("shreddit-post")) {
      const title = post.getAttribute("post-title");
      counts[title] = { prev: 0, next: 0 };
      post.innerHTML =
        '<gallery-carousel><span slot="prevButton"><button aria-label="Previous page"></button></span>' +
        '<span slot="nextButton"><button aria-label="Next page"></button></span></gallery-carousel>';
      for (const direction of ["prev", "next"]) {
        post
          .querySelector(`[slot="${direction}Button"] button`)
          .addEventListener("click", () => {
            counts[title][direction]++;
          });
      }
    }
    return counts;
  }

  it("steps the selected post's gallery in the feed", async () => {
    page = await Page.open();
    const counts = addGalleries(page);
    const selected = page.selectedTitle;
    expect(selected).not.toBeNull();
    await page.send("image_next", "image_next", "image_prev");
    for (const [title, count] of Object.entries(counts)) {
      expect(count, title).toEqual(
        title === selected ? { prev: 1, next: 2 } : { prev: 0, next: 0 },
      );
    }
  });

  it("steps the post's gallery in a thread", async () => {
    page = await Page.open({
      url: "https://www.reddit.com/r/a/comments/1/one/",
    });
    const counts = addGalleries(page);
    await page.send("image_next");
    expect(counts.First).toEqual({ prev: 0, next: 1 });
    expect(counts.Second).toEqual({ prev: 0, next: 0 });
  });

  it("works from the keyboard without the daemon", async () => {
    page = await Page.open({ daemonUp: false });
    const counts = addGalleries(page);
    await page.press("Numpad6");
    await page.press("Numpad4");
    expect(counts[page.selectedTitle]).toEqual({ prev: 1, next: 1 });
  });

  it("does nothing on standby", async () => {
    page = await Page.open();
    const counts = addGalleries(page);
    await page.send("standby", "image_next");
    for (const count of Object.values(counts)) {
      expect(count).toEqual({ prev: 0, next: 0 });
    }
  });
});

describe("typing a speed", () => {
  const doc = () => page.window.document;
  const field = () => doc().querySelector("#rs-hud input.rs-speed-input");

  async function type(value, key = "Enter") {
    doc().querySelector("#rs-hud .rs-speed").click();
    field().value = String(value);
    field().dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key, bubbles: true }),
    );
    await page.settle();
  }

  it("sets the speed, and remembers it for the tab", async () => {
    page = await Page.open({ daemonUp: false });
    await type(40);
    expect(page.hud(".rs-speed")).toBe("\u25bc 40 px/s");
    expect(page.storedSpeed).toBe(40);
  });

  it("goes below the slowest key speed, down to 1", async () => {
    page = await Page.open({ daemonUp: false });
    await type(3);
    expect(page.hud(".rs-speed")).toBe("\u25bc 3 px/s");
    // The next key press moves back onto the steps.
    await page.press("NumpadAdd");
    expect(page.hud(".rs-speed")).toBe("\u25bc 15 px/s");
  });

  it("stops at the maximum", async () => {
    page = await Page.open({ daemonUp: false });
    await type(9999);
    expect(page.hud(".rs-speed")).toBe("\u25bc 600 px/s");
  });

  it("keeps a typed speed below the minimum across a navigation", async () => {
    page = await Page.open({
      daemonUp: false,
      session: JSON.stringify({ speed: 3, exact: true }),
    });
    expect(page.hud(".rs-speed")).toBe("\u25bc 3 px/s");
  });

  it("keeps a typed speed when the daemon's limits arrive", async () => {
    page = await Page.open({
      session: JSON.stringify({ speed: 3, exact: true }),
    });
    expect(page.hud(".rs-speed")).toBe("\u25bc 3 px/s");
  });

  it("ignores the daemon while typing, and for a moment after", async () => {
    // The hook is global: digits typed on the numpad arrive as commands too,
    // and the confirming Enter arrives as "open" just after the field closes.
    page = await Page.open();
    doc().querySelector("#rs-hud .rs-speed").click();
    await page.send("toggle", "reverse");
    expect(page.hud(".rs-status")).toBe("PAUSED");

    field().value = "40";
    field().dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await page.send("open");
    expect(page.navigatedTo).toBeNull();
    expect(page.hud(".rs-speed")).toBe("\u25bc 40 px/s");

    await page.settle(600);
    await page.send("toggle");
    expect(page.hud(".rs-status")).toBe("SCROLLING");
  });
});

describe("the speed you last set", () => {
  it("starts a new tab, without a daemon", async () => {
    page = await Page.open({
      daemonUp: false,
      stored: { "rs-speed": { speed: 200, exact: false } },
    });
    expect(page.hud(".rs-speed")).toBe("\u25bc 200 px/s");
    expect(page.hud(".rs-status")).toBe("PAUSED");
  });

  it("wins over the daemon's default_speed", async () => {
    page = await Page.open({
      settings: { ...SETTINGS, default_speed: 210 },
      stored: { "rs-speed": { speed: 200, exact: false } },
    });
    expect(page.hud(".rs-speed")).toBe("\u25bc 200 px/s");
  });

  it("is stored whenever the speed changes", async () => {
    page = await Page.open({ daemonUp: false });
    await page.press("NumpadAdd");
    expect(page.stored["rs-speed"]).toEqual({ speed: 105, exact: false });
  });

  it("is not stored when nobody set it", async () => {
    // Leaving a page saves the tab's speed. If that also counted as "yours",
    // an untouched default would stick and default_speed would never apply.
    page = await Page.open({
      settings: { ...SETTINGS, default_speed: 210 },
    });
    await page.send("toggle");
    page.window.dispatchEvent(new page.window.Event("pagehide"));
    expect(page.storedSpeed).toBe(210);
    expect(page.stored).not.toHaveProperty("rs-speed");
  });

  it("keeps a typed speed below the minimum, with its flag", async () => {
    page = await Page.open({
      daemonUp: false,
      stored: { "rs-speed": { speed: 3, exact: true } },
    });
    expect(page.hud(".rs-speed")).toBe("\u25bc 3 px/s");
  });

  it("gives way to the tab's own speed", async () => {
    // Two tabs at different speeds each keep theirs across a navigation.
    page = await Page.open({
      daemonUp: false,
      session: JSON.stringify({ speed: 45 }),
      stored: { "rs-speed": { speed: 200, exact: false } },
    });
    expect(page.hud(".rs-speed")).toBe("\u25bc 45 px/s");
  });

  it("accepts a bare number, as someone editing the value by hand would write", async () => {
    page = await Page.open({ daemonUp: false, stored: { "rs-speed": 200 } });
    expect(page.hud(".rs-speed")).toBe("▼ 200 px/s");
  });

  it("is ignored when the stored value is not a speed", async () => {
    for (const junk of ["fast", { speed: "200" }, { speed: -5 }, null, []]) {
      page = await Page.open({
        daemonUp: false,
        stored: { "rs-speed": junk },
      });
      expect(page.hud(".rs-speed"), JSON.stringify(junk)).toBe(
        "\u25bc 90 px/s",
      );
      page.close();
    }
    page = null;
  });
});

describe("the slowest key speed", () => {
  it("is 5 px/s without a daemon to say otherwise", async () => {
    page = await Page.open({ daemonUp: false });
    for (let i = 0; i < 8; i++) await page.press("NumpadSubtract");
    expect(page.hud(".rs-speed")).toBe("\u25bc 5 px/s");
    await page.press("NumpadAdd");
    expect(page.hud(".rs-speed")).toBe("\u25bc 15 px/s");
  });
});

describe("key bindings", () => {
  const doc = () => page.window.document;
  const panel = () => doc().getElementById("rs-bindings");
  const gear = () => doc().querySelector("#rs-hud button.rs-gear");
  const bindButton = (command) =>
    panel().querySelector(`button[data-command="${command}"]`);

  /** Dispatch a cancelable keydown and hand the event back for inspection. */
  async function fire(code, init = {}) {
    const event = new page.window.KeyboardEvent("keydown", {
      code,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    // On body, so it travels window -> document -> body like a real key.
    doc().body.dispatchEvent(event);
    await page.settle();
    return event;
  }

  it("opens from the gear and from the manager's menu", async () => {
    page = await Page.open({ daemonUp: false });
    gear().click();
    expect(panel()).not.toBeNull();
    panel().querySelector("button[data-close]").click();
    expect(panel()).toBeNull();
    page.menu["Key bindings"]();
    expect(panel()).not.toBeNull();
  });

  it("closes the HUD's key list when the panel opens", async () => {
    // Both list the keys, and the open list makes the HUD too tall to sit
    // under the panel.
    page = await Page.open();
    const help = doc().querySelector("#rs-hud .rs-help");
    expect(help.hidden).toBe(false);
    gear().click();
    expect(help.hidden).toBe(true);
    expect(panel()).not.toBeNull();
  });

  it("rebinds a key, uses it, frees the old one, and remembers", async () => {
    page = await Page.open({ daemonUp: false });
    gear().click();
    bindButton("toggle").click();
    await fire("Space", { key: " " });
    // Binding a key must not also run the command.
    expect(page.hud(".rs-status")).toBe("PAUSED");
    expect(page.stored["rs-bindings"].toggle).toEqual({
      code: "Space",
      label: "Space",
    });
    await fire("Escape", { key: "Escape" });
    expect(panel()).toBeNull();

    await fire("Numpad0");
    expect(page.hud(".rs-status")).toBe("PAUSED");
    await fire("Space", { key: " " });
    expect(page.hud(".rs-status")).toBe("SCROLLING");
  });

  it("starts with the bindings the manager has stored", async () => {
    page = await Page.open({
      daemonUp: false,
      stored: { "rs-bindings": { faster: { code: "KeyF", label: "F" } } },
    });
    await fire("KeyF", { key: "f" });
    expect(page.hud(".rs-speed")).toBe("▼ 105 px/s");
  });

  it("does not treat keys as commands while the panel is open", async () => {
    page = await Page.open({ daemonUp: false });
    gear().click();
    await fire("Numpad0");
    expect(page.hud(".rs-status")).toBe("PAUSED");
  });

  it("leaves a bound key alone when Ctrl, Alt or Meta is held", async () => {
    // Binding F must not cost the user Ctrl+F.
    page = await Page.open({
      daemonUp: false,
      stored: { "rs-bindings": { faster: { code: "KeyF", label: "F" } } },
    });
    for (const modifier of ["ctrlKey", "altKey", "metaKey"]) {
      const event = await fire("KeyF", { key: "f", [modifier]: true });
      expect(event.defaultPrevented, modifier).toBe(false);
    }
    expect(page.hud(".rs-speed")).toBe("▼ 90 px/s");
  });

  it("takes a bound key away from the page, and only a bound key", async () => {
    page = await Page.open({ daemonUp: false });
    let reached = 0;
    doc().addEventListener("keydown", () => {
      reached++;
    });
    const bound = await fire("Numpad2");
    expect(bound.defaultPrevented).toBe(true);
    expect(reached).toBe(0);
    const free = await fire("KeyQ");
    expect(free.defaultPrevented).toBe(false);
    expect(reached).toBe(1);
  });

  it("gives the keys back to the page on standby, except the way out", async () => {
    page = await Page.open({
      daemonUp: false,
      stored: { "rs-standby": true },
    });
    expect((await fire("Numpad2")).defaultPrevented).toBe(false);
    expect((await fire("Numpad1")).defaultPrevented).toBe(true);
    expect(page.hud(".rs-status")).toBe("PAUSED");
  });

  it("lists the page's own bindings in the help panel without a daemon", async () => {
    page = await Page.open({
      daemonUp: false,
      stored: { "rs-bindings": { toggle: { code: "Space", label: "Space" } } },
    });
    await fire("NumpadMultiply");
    const help = doc().querySelector("#rs-hud .rs-help");
    expect(help.hidden).toBe(false);
    expect(help.textContent).toContain("Space");
    expect(help.textContent).not.toContain("Num 0");
  });

  it("saves a preset from its button", async () => {
    page = await Page.open({ daemonUp: false });
    gear().click();
    panel().querySelector('button[data-preset="laptop"]').click();
    expect(page.stored["rs-bindings"].toggle.code).toBe("Space");
    await fire("Escape", { key: "Escape" });
    await fire("Space", { key: " " });
    expect(page.hud(".rs-status")).toBe("SCROLLING");
  });

  it("with the daemon connected, says so and leaves the keys to it", async () => {
    page = await Page.open({
      stored: { "rs-bindings": { toggle: { code: "Space", label: "Space" } } },
    });
    const event = await fire("Space", { key: " " });
    expect(event.defaultPrevented).toBe(false);
    expect(page.hud(".rs-status")).toBe("PAUSED");
    gear().click();
    expect(panel().querySelector(".rs-bindings-note").hidden).toBe(false);
    // The help panel still shows what the daemon is actually bound to.
    await fire("Escape", { key: "Escape" });
    await page.send("help");
    const help = doc().querySelector("#rs-hud .rs-help");
    expect(help.hidden).toBe(false);
    expect(help.textContent).toContain("Num 0");
  });
});

describe("the panel's keys and the daemon", () => {
  const doc = () => page.window.document;
  const panel = () => doc().getElementById("rs-bindings");
  const note = () => panel().querySelector(".rs-bindings-note");
  const bindButton = (command) =>
    panel().querySelector(`button[data-command="${command}"]`);
  const openPanel = () => doc().querySelector("#rs-hud button.rs-gear").click();
  const SPACE = { toggle: { code: "Space", label: "Space" } };

  async function fire(code, init = {}, target = doc().body) {
    const event = new page.window.KeyboardEvent("keydown", {
      code,
      bubbles: true,
      composed: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    await page.settle();
    return event;
  }

  it("are sent to the daemon when the page connects", async () => {
    page = await Page.open({
      daemonKeys: true,
      stored: { "rs-bindings": SPACE },
    });
    await page.settle();
    expect(page.sentBindings).toHaveLength(1);
    expect(page.sentBindings[0]).toEqual({ ...NUMPAD_CODES, toggle: "Space" });
  });

  it("are not sent when the panel was never changed", async () => {
    // config.json's keys stay in effect until the user changes one here.
    page = await Page.open({
      daemonKeys: true,
      settings: {
        ...SETTINGS,
        binding_codes: { ...NUMPAD_CODES, toggle: "Numpad9" },
      },
    });
    await page.settle();
    expect(page.sentBindings).toEqual([]);
    expect(page.stored).not.toHaveProperty("rs-bindings");
    // ...and the panel and the key list show the daemon's keys.
    openPanel();
    expect(bindButton("toggle").textContent).toBe("Num 9");
    expect(note().textContent).toContain("config.json");
  });

  it("take over from config.json at the first change, keeping its other keys", async () => {
    page = await Page.open({
      daemonKeys: true,
      settings: {
        ...SETTINGS,
        binding_codes: { ...NUMPAD_CODES, toggle: "Numpad9" },
      },
    });
    openPanel();
    bindButton("faster").click();
    await fire("KeyF", { key: "f" });
    expect(page.sentBindings.at(-1)).toEqual({
      ...NUMPAD_CODES,
      toggle: "Numpad9",
      faster: "KeyF",
    });
    expect(page.stored["rs-bindings"].toggle.code).toBe("Numpad9");
    expect(note().hidden).toBe(true);
  });

  it("are sent again on every change", async () => {
    page = await Page.open({
      daemonKeys: true,
      stored: { "rs-bindings": SPACE },
    });
    openPanel();
    panel().querySelector('button[data-preset="laptop"]').click();
    await page.settle();
    expect(page.sentBindings).toHaveLength(2);
    expect(page.sentBindings[1].faster).toBe("KeyF");
  });

  it("leave a bound key to the daemon, but keep it from the page", async () => {
    // The daemon delivers the command. If the page acted too it would run
    // twice; if it let the key through, Space would also scroll.
    page = await Page.open({
      daemonKeys: true,
      stored: { "rs-bindings": SPACE },
    });
    await page.settle();
    const event = await fire("Space", { key: " " });
    expect(event.defaultPrevented).toBe(true);
    expect(page.hud(".rs-status")).toBe("PAUSED");
    await page.send("toggle");
    expect(page.hud(".rs-status")).toBe("SCROLLING");
  });

  it("handle a key the daemon cannot hook in the page instead", async () => {
    page = await Page.open({
      daemonKeys: ["toggle"],
      stored: { "rs-bindings": SPACE },
    });
    await page.settle();
    await fire("Space", { key: " " });
    expect(page.hud(".rs-status")).toBe("SCROLLING");
    openPanel();
    expect(note().textContent).toContain("pause / resume");
  });

  it("stay page-only with a daemon that predates them", async () => {
    page = await Page.open({ stored: { "rs-bindings": SPACE } });
    await page.settle();
    const event = await fire("Space", { key: " " });
    expect(event.defaultPrevented).toBe(false);
    openPanel();
    expect(note().textContent).toContain("config.json");
  });

  it("show the keys in the key list once the daemon follows them", async () => {
    page = await Page.open({
      daemonKeys: true,
      stored: { "rs-bindings": SPACE },
    });
    await page.settle();
    const help = doc().querySelector("#rs-hud .rs-help");
    expect(help.hidden).toBe(false);
    expect(help.textContent).toContain("Space");
  });
});

describe("typing in a Reddit text field", () => {
  const doc = () => page.window.document;

  function field({ inShadow = false } = {}) {
    const input = doc().createElement("textarea");
    if (inShadow) {
      const host = doc().createElement("shreddit-composer");
      host.attachShadow({ mode: "open" }).append(input);
      doc().body.append(host);
    } else {
      doc().body.append(input);
    }
    input.focus();
    return input;
  }

  it("drops commands from the daemon, whose hook cannot see focus", async () => {
    // Backspace bound to "back" must not navigate away from a comment draft.
    page = await Page.open();
    const input = field();
    await page.send("toggle");
    expect(page.hud(".rs-status")).toBe("PAUSED");
    input.blur();
    await page.send("toggle");
    expect(page.hud(".rs-status")).toBe("SCROLLING");
  });

  it("finds the field inside an open shadow root", async () => {
    page = await Page.open();
    field({ inShadow: true });
    await page.send("toggle");
    expect(page.hud(".rs-status")).toBe("PAUSED");
  });

  it("does not drop them once another window has the focus", async () => {
    // A field stays the active element after alt-tabbing away. That must not
    // leave the numpad dead for as long as the game is in front.
    page = await Page.open();
    field();
    doc().hasFocus = () => false;
    await page.send("toggle");
    expect(page.hud(".rs-status")).toBe("SCROLLING");
  });

  it("treats a key typed inside a shadow root as text, not a command", async () => {
    page = await Page.open({ daemonUp: false });
    const input = field({ inShadow: true });
    const event = new page.window.KeyboardEvent("keydown", {
      code: "Numpad0",
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    await page.settle();
    expect(event.defaultPrevented).toBe(false);
    expect(page.hud(".rs-status")).toBe("PAUSED");
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
