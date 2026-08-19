/**
 * The same behaviour, in every browser this project supports.
 *
 * The jsdom suites prove the logic; they cannot prove the engine agrees. This
 * file runs the shipped bundle in real Chromium and real Firefox against a
 * real daemon, and asserts the things that are actually engine-dependent:
 * that the page scrolls, that layout puts the right post on the focus line,
 * that navigation preserves the speed, and that KeyboardEvent.code carries
 * the numpad names the fallback handler is written against.
 */

import { expect, test } from "@playwright/test";

import { nextPort, POSTS, preparePage, startDaemon } from "./fixture.js";

const FEED = "https://www.reddit.com/";

/** The state the page last reported, read back out of the daemon. */
async function daemonState(port) {
  const response = await fetch(`http://127.0.0.1:${port}/state`);
  return response.json();
}

/** Wait until the page's reported state satisfies `predicate`. */
async function waitForState(port, predicate, what) {
  const deadline = Date.now() + 10000;
  let last = null;
  while (Date.now() < deadline) {
    last = await daemonState(port);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out waiting for ${what}; last state ${JSON.stringify(last)}`,
  );
}

test.describe("the userscript in a real browser", () => {
  let daemon;

  test.beforeEach(async ({ page }, testInfo) => {
    daemon = await startDaemon(nextPort(testInfo));
    await preparePage(page, daemon.port);
    await page.goto(FEED);
    // The page posts its state once a second; the first arrival is also the
    // proof that the transport connected in this engine.
    await waitForState(
      daemon.port,
      (state) => state.daemonConnected,
      "the daemon connection",
    );
  });

  test.afterEach(async () => {
    await daemon?.stop();
  });

  test("mounts a HUD reporting the daemon's settings", async ({ page }) => {
    const hud = page.locator("#rs-hud");
    await expect(hud).toBeVisible();
    await expect(hud.locator(".rs-status")).toHaveText("PAUSED");
    await expect(hud.locator(".rs-daemon")).toHaveText("● daemon");
    // 90 px/s is config.py's default_speed, so this arrived over the wire.
    await expect(hud.locator(".rs-speed")).toHaveText("▼ 90 px/s");
    await expect(hud.locator(".rs-mode")).toHaveText("FEED");
  });

  test("lists the daemon's real bindings in the help panel", async ({
    page,
  }) => {
    // The panel shows itself for six seconds when a page loads, so it is
    // already up by the time the connection is established -- and the rows in
    // it are the bindings the daemon has just sent.
    const rows = page.locator("#rs-hud .rs-help-row");
    await expect(rows.first()).toBeVisible();
    await expect(rows).toHaveCount(9);
    await expect(rows.locator(".rs-help-key").first()).toHaveText("Num 0");

    daemon.send("help");
    await expect(rows.first()).toBeHidden();
  });

  test("scrolls the window at the configured speed", async ({ page }) => {
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    daemon.send("toggle");
    await waitForState(
      daemon.port,
      (state) => state.running,
      "scrolling to start",
    );

    const first = await page.evaluate(() => window.scrollY);
    await page.waitForTimeout(2000);
    const second = await page.evaluate(() => window.scrollY);

    // 90 px/s over ~2s, generous either way: this asserts the engine moves
    // the window at roughly the right rate, not that timers are exact.
    expect(second - first).toBeGreaterThan(80);
    expect(second - first).toBeLessThan(300);
  });

  test("changes speed and direction on command", async ({ page }) => {
    daemon.send("faster");
    daemon.send("faster");
    await expect(page.locator("#rs-hud .rs-speed")).toHaveText("▼ 120 px/s");

    daemon.send("slower");
    await expect(page.locator("#rs-hud .rs-speed")).toHaveText("▼ 105 px/s");

    daemon.send("reverse");
    await expect(page.locator("#rs-hud .rs-speed")).toHaveText("▲ 105 px/s");
    // Reversing changes the arrow, never the speed. The page posts its state
    // once a second, so this waits rather than reading whatever is there.
    const state = await waitForState(
      daemon.port,
      (posted) => posted.direction === -1,
      "the reversed direction",
    );
    expect(state.speed).toBe(105);
  });

  test("scrolls back up once reversed", async ({ page }) => {
    daemon.send("next");
    daemon.send("next");
    await page.waitForFunction(() => window.scrollY > 200);

    const high = await page.evaluate(() => window.scrollY);
    daemon.send("reverse");
    daemon.send("toggle");
    await page.waitForFunction((from) => window.scrollY < from - 50, high, {
      timeout: 10000,
    });
  });

  test("moves the selection outline through the feed", async ({ page }) => {
    const outlined = page.locator("shreddit-post.rs-selected");
    await expect(outlined).toHaveAttribute("post-title", POSTS[0].title);

    daemon.send("next");
    await expect(outlined).toHaveAttribute("post-title", POSTS[1].title);

    daemon.send("next");
    await expect(outlined).toHaveAttribute("post-title", POSTS[2].title);

    daemon.send("prev");
    await expect(outlined).toHaveAttribute("post-title", POSTS[1].title);

    // The outline is what makes the choice visible from another monitor.
    await expect(outlined).toHaveCSS("outline-style", "solid");
  });

  test("keeps the selected post on the focus line", async ({ page }) => {
    daemon.send("next");
    await expect(page.locator("shreddit-post.rs-selected")).toHaveAttribute(
      "post-title",
      POSTS[1].title,
    );

    const offset = await page.evaluate(() => {
      const element = document.querySelector("shreddit-post.rs-selected");
      return element.getBoundingClientRect().top - window.innerHeight * 0.25;
    });
    expect(Math.abs(offset)).toBeLessThan(4);
  });

  test("opens a post paused at the top, and comes back", async ({ page }) => {
    daemon.send("faster");
    await expect(page.locator("#rs-hud .rs-speed")).toHaveText("▼ 105 px/s");
    daemon.send("toggle");
    await waitForState(
      daemon.port,
      (state) => state.running,
      "scrolling to start",
    );

    // Which post is under the focus line depends on how far the feed got
    // before the command landed, so match any thread rather than pinning one.
    daemon.send("open");
    await page.waitForURL(/\/comments\//);

    const opened = await waitForState(
      daemon.port,
      (state) => state.mode === "thread",
      "thread mode",
    );
    // Never scrolled past the opening post, and never scrolling on arrival.
    expect(opened.running).toBe(false);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // The speed survives the navigation; sessionStorage is per-tab, per-engine.
    expect(opened.speed).toBe(105);

    daemon.send("back");
    await page.waitForURL(FEED);
    const returned = await waitForState(
      daemon.port,
      (state) => state.mode === "feed",
      "the feed",
    );
    expect(returned.running).toBe(false);
    expect(returned.postCount).toBe(POSTS.length);
  });

  test("pages by screenfuls inside a thread", async ({ page }) => {
    daemon.send("open");
    await page.waitForURL(`https://www.reddit.com${POSTS[0].permalink}`);
    await waitForState(
      daemon.port,
      (state) => state.mode === "thread",
      "thread mode",
    );

    daemon.send("next");
    await page.waitForFunction(() => window.scrollY > 0);
    const [scrolled, expected] = await page.evaluate(() => [
      window.scrollY,
      window.innerHeight * 0.8,
    ]);
    expect(Math.abs(scrolled - expected)).toBeLessThan(2);
  });
});

test.describe("without a daemon", () => {
  // The in-page handler is the only thing that works when the daemon is down,
  // and it is keyed on KeyboardEvent.code -- exactly the sort of thing that
  // could differ between engines. It does not, and this is what says so.
  test("still responds to the numpad keys", async ({ page }, testInfo) => {
    // A port nothing is listening on: the transport must fail and stay out of
    // the way rather than swallowing the keys.
    await preparePage(page, nextPort(testInfo));
    await page.goto(FEED);
    await expect(page.locator("#rs-hud .rs-daemon")).toHaveText(
      "● browser only",
    );

    await page.locator("body").press("NumpadAdd");
    await expect(page.locator("#rs-hud .rs-speed")).toHaveText("▼ 105 px/s");

    await page.locator("body").press("Numpad5");
    await expect(page.locator("#rs-hud .rs-speed")).toHaveText("▲ 105 px/s");

    await page.locator("body").press("Numpad0");
    await expect(page.locator("#rs-hud .rs-status")).toHaveText("SCROLLING");

    await page.locator("body").press("NumpadMultiply");
    await expect(page.locator("#rs-hud .rs-help-row").first()).toBeVisible();
  });
});
