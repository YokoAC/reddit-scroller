/** Entry point: wires the transport, scroll engine, selection and HUD together. */

import { commandForKeyCode, detectMode, resolveAction } from "./commands.js";
import { Hud } from "./hud.js";
import { ScrollEngine } from "./scroll.js";
import { Selection } from "./selection.js";
import {
  DEFAULT_PORT,
  gmRequest,
  normalisePort,
  Transport,
} from "./transport.js";

const PORT_KEY = "rs-port";
const STANDBY_KEY = "rs-standby";
const STATE_KEY = "rs-scroll-state";
const FLASH_MS = 900;
const HELP_AUTOSHOW_MS = 6000;

const DEFAULTS = {
  speed_min: 15,
  speed_max: 600,
  speed_step: 15,
  default_speed: 90,
  focus_line: 0.25,
};

// Speed lives in sessionStorage, not GM storage: it should survive opening a
// thread and coming back, but a brand-new tab is a fresh start that honours
// config.json's default_speed. Nothing about whether we were scrolling is
// remembered -- a page must never begin scrolling on its own.
function loadPersisted() {
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function persist(state) {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // Persistence is a nicety; losing it is not worth breaking over.
  }
}

// The port used to be a constant compiled into the bundle, which meant moving
// it took an npm install, a rebuild and a reinstall -- the whole toolchain the
// setup deliberately avoids. Worse, the daemon's own "port in use" message
// tells you to edit config.json, and doing so silently left the page polling
// the old port. Reading it from GM storage puts it where the manager already
// shows it, editable in the same UI the script was installed from.
function loadPort() {
  try {
    const stored = GM_getValue(PORT_KEY);
    if (stored === undefined || stored === null || stored === "") {
      // Seed it so the key is visible in the manager rather than something a
      // reader has to know to create. This is the only write.
      GM_setValue(PORT_KEY, DEFAULT_PORT);
      return DEFAULT_PORT;
    }
    return normalisePort(stored);
  } catch {
    // A manager that withholds GM storage still gets a working script.
    return DEFAULT_PORT;
  }
}

// Standby is a preference, not scroll state, so unlike "was running" it is
// safe to remember: it can only ever make the script do less. Seeded on first
// run for the same reason the port is -- so the key is visible in the manager
// rather than something a reader has to know to create.
function loadStandby() {
  try {
    const stored = GM_getValue(STANDBY_KEY);
    if (stored === undefined || stored === null || stored === "") {
      GM_setValue(STANDBY_KEY, false);
      return false;
    }
    return stored === true || stored === "true";
  } catch {
    return false;
  }
}

function saveStandby(value) {
  try {
    GM_setValue(STANDBY_KEY, value);
  } catch {
    // Same bargain as the speed: a manager that withholds storage still works.
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
  let standby = loadStandby();
  let daemonConnected = false;
  let helpVisible = false;
  let helpTimer = null;
  let helpShownOnce = false;
  let lastCommand = null;
  let flashTimer = null;

  function snapshot() {
    return {
      running: engine.running,
      speed: engine.speed,
      direction: engine.direction,
      speedMin: settings.speed_min,
      speedMax: settings.speed_max,
      mode,
      selected: selection.selected,
      postCount: selection.count,
      daemonConnected,
      lastCommand,
      bindings: settings.bindings,
      helpVisible,
      standby,
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

  // Navigation always lands paused, so the top of a thread (or the feed you
  // came back to) is never scrolled past before you can read it. Stopping the
  // engine matters as much as persisting: the back-forward cache can restore
  // a page without re-running this script at all.
  function leavePaused() {
    engine.stop();
    persist({ speed: engine.speed });
  }

  function showHelp(visible) {
    helpVisible = visible;
    if (helpTimer) {
      clearTimeout(helpTimer);
      helpTimer = null;
    }
    paint();
  }

  function saveSpeed() {
    persist({ speed: engine.speed });
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
      saveSpeed();
    },
    speedUp() {
      engine.adjustSpeed(settings.speed_step);
      saveSpeed();
    },
    speedDown() {
      engine.adjustSpeed(-settings.speed_step);
      saveSpeed();
    },
    openSelected() {
      const post = selection.selected;
      if (!post) return;
      leavePaused();
      window.location.href = post.permalink;
    },
    goBack() {
      leavePaused();
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
    flipDirection() {
      engine.flipDirection();
    },
    toggleHelp() {
      showHelp(!helpVisible);
    },
    toggleStandby() {
      standby = !standby;
      saveStandby(standby);
      if (!standby) return;
      // Leave the page as we found it: stop, save, and take the class off
      // rather than merely styling it away. refresh() puts it back on wake.
      engine.stop();
      saveSpeed();
      selection.clearHighlight();
    },
    pageDown() {
      window.scrollBy(0, window.innerHeight * 0.8);
    },
    pageUp() {
      window.scrollBy(0, -window.innerHeight * 0.8);
    },
    noop() {},
  };

  // The one gate both input paths pass through: the daemon's transport and
  // the in-page keydown fallback both arrive here. Dormant ignores everything
  // that touches the page; standby wakes it, and help only draws a panel.
  function handleCommand(command) {
    if (standby && command !== "standby" && command !== "help") return;
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
      if (!standby && mode === "feed") {
        selection.refresh();
        selection.applyHighlight();
      }
      paint();
    });
  }

  const transport = new Transport({
    port: loadPort(),
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
        // A script that was switched off should not greet anyone.
        if (!helpShownOnce && !standby) {
          helpShownOnce = true;
          helpVisible = true;
          helpTimer = setTimeout(() => {
            helpVisible = false;
            helpTimer = null;
            paint();
          }, HELP_AUTOSHOW_MS);
        }
      }
      // refresh(), not paint(): adopting the daemon's focus_line changes which
      // post is current, so the selection has to be recomputed rather than
      // merely redrawn. paint() alone left the old selection standing until
      // the next scroll happened to correct it.
      refresh();
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
  window.addEventListener("pagehide", saveSpeed);

  setInterval(() => transport.postState(snapshot()), 1000);

  refresh();
  transport.start();
}

boot();
