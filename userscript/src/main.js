/** Entry point: wires the transport, scroll engine, selection and HUD together. */

import { commandForKeyCode, detectMode, resolveAction } from "./commands.js";
import { Hud } from "./hud.js";
import { ScrollEngine } from "./scroll.js";
import { Selection } from "./selection.js";
import { Transport, gmRequest } from "./transport.js";

const PORT = 8765;
const STATE_KEY = "rs-scroll-state";
const FLASH_MS = 900;

const DEFAULTS = {
  speed_min: 15,
  speed_max: 600,
  speed_step: 15,
  default_speed: 90,
  focus_line: 0.25,
};

function loadPersisted() {
  try {
    const raw = GM_getValue(STATE_KEY, null);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function persist(state) {
  try {
    GM_setValue(STATE_KEY, JSON.stringify(state));
  } catch {
    // Persistence is a nicety; losing it is not worth breaking over.
  }
}

function boot() {
  const settings = { ...DEFAULTS };
  const persisted = loadPersisted();

  const engine = new ScrollEngine({
    scrollBy: (dy) => window.scrollBy(0, dy),
    requestFrame: (cb) => window.requestAnimationFrame(cb),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    speed: persisted?.speed ?? settings.default_speed,
    min: settings.speed_min,
    max: settings.speed_max,
    step: settings.speed_step,
    // A persisted speed is a deliberate prior choice; the daemon's
    // default_speed must not override it once it arrives.
    seeded: typeof persisted?.speed === "number",
  });

  const selection = new Selection({
    root: document,
    getViewportHeight: () => window.innerHeight,
    focusLine: settings.focus_line,
  });

  const hud = new Hud(document);
  hud.mount();

  let mode = detectMode(window.location.pathname);
  let daemonConnected = false;
  let lastCommand = null;
  let flashTimer = null;

  function snapshot() {
    return {
      running: engine.running,
      speed: engine.speed,
      speedMin: settings.speed_min,
      speedMax: settings.speed_max,
      mode,
      selected: selection.selected,
      postCount: selection.count,
      daemonConnected,
      lastCommand,
    };
  }

  function paint() {
    hud.render(snapshot());
  }

  function flash(command) {
    lastCommand = command;
    paint();
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      lastCommand = null;
      paint();
    }, FLASH_MS);
  }

  function savePosition() {
    persist({ running: engine.running, speed: engine.speed });
  }

  function scrollToSelected() {
    const element = selection.selectedElement;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const target = window.innerHeight * settings.focus_line;
    window.scrollBy(0, rect.top - target);
  }

  const ACTIONS = {
    toggleScroll() {
      engine.toggle();
      savePosition();
    },
    speedUp() {
      engine.adjustSpeed(settings.speed_step);
      savePosition();
    },
    speedDown() {
      engine.adjustSpeed(-settings.speed_step);
      savePosition();
    },
    openSelected() {
      const post = selection.selected;
      if (!post) return;
      savePosition();
      window.location.href = post.permalink;
    },
    goBack() {
      savePosition();
      window.history.back();
    },
    selectNext() {
      selection.move(1);
      scrollToSelected();
      selection.applyHighlight();
    },
    selectPrev() {
      selection.move(-1);
      scrollToSelected();
      selection.applyHighlight();
    },
    pageDown() {
      window.scrollBy(0, window.innerHeight * 0.8);
    },
    pageUp() {
      window.scrollBy(0, -window.innerHeight * 0.8);
    },
    noop() {},
  };

  function handleCommand(command) {
    flash(command);
    (ACTIONS[resolveAction(command, mode)] || ACTIONS.noop)();
    refresh();
  }

  let refreshQueued = false;
  function refresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    window.requestAnimationFrame(() => {
      refreshQueued = false;
      mode = detectMode(window.location.pathname);
      if (mode === "feed") {
        selection.refresh();
        selection.applyHighlight();
      }
      paint();
    });
  }

  const transport = new Transport({
    port: PORT,
    request: gmRequest,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onCommands: (commands) => {
      // A background tab should not steal commands aimed at the visible one.
      if (document.hidden) return;
      commands.forEach(handleCommand);
    },
    onConnectionChange: (ok) => {
      daemonConnected = ok;
      if (ok && transport.settings) {
        Object.assign(settings, transport.settings);
        // Both were built from built-in defaults; adopt the user's config.
        engine.setLimits(settings.speed_min, settings.speed_max);
        engine.seedDefaultSpeed(settings.default_speed);
        selection.setFocusLine(settings.focus_line);
      }
      paint();
    },
  });

  function isTyping(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  }

  window.addEventListener("scroll", refresh, { passive: true });
  window.addEventListener("keydown", (event) => {
    // Numpad keys typed into Reddit's search box are text, not commands.
    if (isTyping(event.target)) return;
    // The daemon's hook is global and fires regardless of window focus, so
    // when it is connected it already delivers this same keypress over the
    // transport. This in-page fallback exists only to make the script
    // usable (and testable) without the daemon running.
    if (daemonConnected) return;
    const command = commandForKeyCode(event.code);
    if (command) handleCommand(command);
  });
  window.addEventListener("popstate", refresh);
  window.addEventListener("pagehide", savePosition);

  setInterval(() => transport.postState(snapshot()), 1000);

  refresh();
  if (persisted?.running) engine.start();
  transport.start();
}

boot();
