// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { HUD_ID, Hud } from "../src/hud.js";

const STATE = {
  running: false,
  speed: 90,
  speedMin: 15,
  speedMax: 600,
  mode: "feed",
  selected: { title: "Hello", subreddit: "r/test", score: 1 },
  postCount: 3,
  daemonConnected: false,
  lastCommand: null,
};

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("Hud", () => {
  it("mounts one panel and its stylesheet", () => {
    new Hud(document).mount();
    expect(document.querySelectorAll(`#${HUD_ID}`)).toHaveLength(1);
    expect(document.querySelectorAll("style#rs-style")).toHaveLength(1);
  });

  it("mounting twice does not produce two panels", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.mount();
    expect(document.querySelectorAll(`#${HUD_ID}`)).toHaveLength(1);
  });

  it("a second instance adopts an existing panel and can still render it", () => {
    const first = new Hud(document);
    first.mount();
    // Render before adopting: render() rewrites class attributes, so a
    // pristine panel would not exercise the case that actually breaks.
    first.render(STATE);
    const second = new Hud(document);
    second.mount();
    second.render({ ...STATE, speed: 300 });
    expect(document.querySelectorAll(`#${HUD_ID}`)).toHaveLength(1);
    expect(document.querySelector(`#${HUD_ID}`).textContent).toContain("300 px/s");
  });

  it("writes the state into the panel", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.render(STATE);
    const text = document.querySelector(`#${HUD_ID}`).textContent;
    expect(text).toContain("PAUSED");
    expect(text).toContain("90 px/s");
    expect(text).toContain("FEED");
    expect(text).toContain("r/test");
    expect(text).toContain("no daemon");
  });

  it("renders titles as text, never as markup", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.render({
      ...STATE,
      selected: { title: "<img src=x onerror=alert(1)>", subreddit: "<script>alert(2)</script>", score: 0 },
      lastCommand: "<iframe src=x></iframe>",
    });
    expect(document.querySelector(`#${HUD_ID}`).querySelector("img")).toBeNull();
    expect(document.querySelector(`#${HUD_ID}`).querySelector("script")).toBeNull();
    expect(document.querySelector(`#${HUD_ID}`).querySelector("iframe")).toBeNull();
  });

  it("rendering before mount is harmless", () => {
    expect(() => new Hud(document).render(STATE)).not.toThrow();
  });

  it("unmount removes the panel", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.unmount();
    expect(document.querySelector(`#${HUD_ID}`)).toBeNull();
  });
});
