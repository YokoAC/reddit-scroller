// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("collapses to the top row on standby and expands again after", () => {
    const hud = new Hud(document);
    hud.mount();
    const root = document.getElementById(HUD_ID);

    hud.render({ ...STATE, standby: true });
    expect(root.classList.contains("rs-collapsed")).toBe(true);
    // The row that survives still carries both facts it always did.
    expect(root.querySelector(".rs-status").textContent).toBe("OFF");
    expect(root.querySelector(".rs-daemon").textContent).toContain(
      "browser only",
    );

    hud.render(STATE);
    expect(root.classList.contains("rs-collapsed")).toBe(false);
  });

  it("has a gear that reports clicks, and is the only clickable part", () => {
    let clicks = 0;
    const hud = new Hud(document, {
      onSettings: () => {
        clicks++;
      },
    });
    hud.mount();
    const gear = document.querySelector(`#${HUD_ID} button.rs-gear`);
    expect(gear.getAttribute("aria-label")).toBe("Key bindings");
    gear.click();
    expect(clicks).toBe(1);
    // It sits in the row that survives standby, so it stays reachable.
    expect(gear.parentElement).toBe(
      document.getElementById(HUD_ID).firstElementChild,
    );
    expect(document.querySelectorAll(`#${HUD_ID} button`)).toHaveLength(1);
  });

  it("wires the gear on a panel it adopts", () => {
    new Hud(document).mount();
    let clicks = 0;
    const second = new Hud(document, {
      onSettings: () => {
        clicks++;
      },
    });
    second.mount();
    document.querySelector(`#${HUD_ID} button.rs-gear`).click();
    expect(clicks).toBe(1);
  });

  describe("typing a speed", () => {
    const speedText = () => document.querySelector(`#${HUD_ID} .rs-speed`);
    const field = () =>
      document.querySelector(`#${HUD_ID} input.rs-speed-input`);
    const press = (key) =>
      field().dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );

    function open() {
      const typed = [];
      const hud = new Hud(document, { onSpeed: (value) => typed.push(value) });
      hud.mount();
      hud.render(STATE);
      speedText().click();
      return { hud, typed };
    }

    afterEach(() => vi.useRealTimers());

    it("turns the speed into a number field holding the current value", () => {
      open();
      expect(field().type).toBe("number");
      expect(field().value).toBe("90");
      expect(field().getAttribute("aria-label")).toMatch(/speed/i);
      expect(speedText().hidden).toBe(true);
      expect(document.activeElement).toBe(field());
    });

    it("reports the typed value on Enter and puts the text back", () => {
      const { typed } = open();
      field().value = "7";
      press("Enter");
      expect(typed).toEqual([7]);
      expect(field()).toBeNull();
      expect(speedText().hidden).toBe(false);
    });

    it("reports it when the field loses focus", () => {
      const { typed } = open();
      field().value = "250";
      field().dispatchEvent(new FocusEvent("blur"));
      expect(typed).toEqual([250]);
      expect(field()).toBeNull();
    });

    it("drops the edit on Escape", () => {
      const { typed } = open();
      field().value = "7";
      press("Escape");
      expect(typed).toEqual([]);
      expect(field()).toBeNull();
    });

    it("ignores anything that is not a speed", () => {
      for (const junk of ["", "0", "-4", "0.2"]) {
        const { typed } = open();
        field().value = junk;
        press("Enter");
        expect(typed, JSON.stringify(junk)).toEqual([]);
        document.body.innerHTML = "";
      }
    });

    it("keeps its keys to itself", () => {
      // A digit typed here must not reach a page shortcut on the same key.
      open();
      let reached = 0;
      document.addEventListener("keydown", () => {
        reached++;
      });
      press("5");
      expect(reached).toBe(0);
    });

    it("counts as editing while open and for a moment after", () => {
      // The daemon delivers the confirming Enter as a command slightly later.
      vi.useFakeTimers();
      const { hud } = open();
      expect(hud.editing).toBe(true);
      press("Enter");
      expect(hud.editing).toBe(true);
      vi.advanceTimersByTime(499);
      expect(hud.editing).toBe(true);
      vi.advanceTimersByTime(2);
      expect(hud.editing).toBe(false);
    });

    it("is not editing before anything was typed", () => {
      const hud = new Hud(document);
      hud.mount();
      expect(hud.editing).toBe(false);
    });
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
    expect(document.querySelector(`#${HUD_ID}`).textContent).toContain(
      "300 px/s",
    );
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
    expect(text).toContain("browser only");
  });

  it("renders titles as text, never as markup", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.render({
      ...STATE,
      selected: {
        title: "<img src=x onerror=alert(1)>",
        subreddit: "<script>alert(2)</script>",
        score: 0,
      },
      lastCommand: "<iframe src=x></iframe>",
    });
    expect(
      document.querySelector(`#${HUD_ID}`).querySelector("img"),
    ).toBeNull();
    expect(
      document.querySelector(`#${HUD_ID}`).querySelector("script"),
    ).toBeNull();
    expect(
      document.querySelector(`#${HUD_ID}`).querySelector("iframe"),
    ).toBeNull();
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

describe("Hud help panel", () => {
  const BINDINGS = {
    toggle: "numpad0",
    faster: "numpad_plus",
    reverse: "numpad5",
    help: "numpad_star",
  };

  const WITH_HELP = { ...STATE, bindings: BINDINGS, helpVisible: true };

  it("is hidden until asked for", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.render({ ...STATE, bindings: BINDINGS, helpVisible: false });
    const panel = document.querySelector(".rs-help");
    expect(panel).not.toBeNull();
    expect(panel.hidden).toBe(true);
  });

  it("lists the bindings when shown", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.render(WITH_HELP);
    const panel = document.querySelector(".rs-help");
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain("Num 0");
    expect(panel.textContent).toContain("pause / resume");
    expect(panel.textContent).toContain("Num 5");
  });

  it("shows the rebound key, not the default", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.render({ ...WITH_HELP, bindings: { ...BINDINGS, reverse: "numpad9" } });
    const panel = document.querySelector(".rs-help");
    expect(panel.textContent).toContain("Num 9");
    expect(panel.textContent).not.toContain("Num 5");
  });

  it("rebuilds cleanly rather than appending on every render", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.render(WITH_HELP);
    hud.render(WITH_HELP);
    const rows = document.querySelectorAll(".rs-help .rs-help-row");
    expect(rows).toHaveLength(4);
  });

  it("renders binding text as text, never as markup", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.render({ ...WITH_HELP, bindings: { toggle: "<img src=x onerror=1>" } });
    expect(document.querySelector(".rs-help img")).toBeNull();
  });

  it("survives having no bindings at all (daemon down)", () => {
    const hud = new Hud(document);
    hud.mount();
    expect(() =>
      hud.render({ ...STATE, bindings: null, helpVisible: true }),
    ).not.toThrow();
  });
});

describe("Hud remounting", () => {
  it("reuses the stylesheet an earlier mount left in the head", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.unmount();
    hud.mount();
    expect(document.querySelectorAll("style#rs-style")).toHaveLength(1);
    expect(document.querySelectorAll(`#${HUD_ID}`)).toHaveLength(1);
  });

  it("unmounting a second time is harmless", () => {
    const hud = new Hud(document);
    hud.mount();
    hud.unmount();
    hud.unmount();
    expect(document.querySelectorAll(`#${HUD_ID}`)).toHaveLength(0);
  });

  it("renders into an adopted panel that predates the help row", () => {
    // What a previous version of the script would have left on the page:
    // every node render() writes to, but no help element behind it.
    document.body.innerHTML = `
      <div id="${HUD_ID}">
        <span class="rs-status"></span>
        <span class="rs-daemon"></span>
        <span class="rs-speed"></span>
        <span class="rs-bar"></span>
        <div class="rs-mode"></div>
        <div class="rs-sub"></div>
        <div class="rs-title"></div>
        <div class="rs-flash"></div>
      </div>`;
    const hud = new Hud(document);
    hud.mount();
    hud.render(STATE);
    expect(document.querySelector(".rs-title").textContent).toContain("Hello");
  });
});
