/** Entry point: wires the transport, scroll engine, selection and HUD together. */

import {
  assign,
  commandFor,
  fromPreset,
  labelsOf,
  parseStored,
} from "./bindings.js";
import { detectMode, resolveAction } from "./commands.js";
import { stepGallery } from "./gallery.js";
import { HELP_ORDER, HUD_ID, Hud } from "./hud.js";
import { BindingsPanel } from "./panel.js";
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
const BINDINGS_KEY = "rs-bindings";
const SPEED_KEY = "rs-speed";
const STATE_KEY = "rs-scroll-state";
const FLASH_MS = 900;
const HELP_AUTOSHOW_MS = 6000;

const DEFAULTS = {
  speed_min: 5,
  speed_max: 600,
  speed_step: 15,
  default_speed: 90,
  focus_line: 0.25,
};

/** A stored speed, or null. Both stores are user-editable, so check it. */
function asSpeed(value) {
  const speed = typeof value === "number" ? value : value?.speed;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) {
    return null;
  }
  return { speed, exact: value?.exact === true };
}

// The speed is kept in two places. sessionStorage holds this tab's own, so
// two tabs at different speeds each keep theirs across a navigation. GM
// storage holds the one last set anywhere, which is where a new tab starts.
// Nothing about whether we were scrolling is remembered -- a page must never
// begin scrolling on its own.
function loadPersisted() {
  try {
    const own = asSpeed(JSON.parse(sessionStorage.getItem(STATE_KEY)));
    if (own) return own;
  } catch {
    // Fall through to the shared one.
  }
  try {
    return asSpeed(GM_getValue(SPEED_KEY));
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

// Only for a speed the user set. The tab's speed is saved on every page
// unload; storing that here too would make an untouched default "theirs",
// and config.json's default_speed would stop applying after the first page.
function persistChosen(state) {
  try {
    GM_setValue(SPEED_KEY, state);
  } catch {
    // It still applies in this tab.
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

// Not seeded like the port: the panel is the way to change these, so the raw
// value does not need to be discoverable in the manager.
function loadBindings() {
  try {
    return parseStored(GM_getValue(BINDINGS_KEY));
  } catch {
    return fromPreset("numpad");
  }
}

function saveBindings(bindings) {
  try {
    GM_setValue(BINDINGS_KEY, bindings);
  } catch {
    // They still apply until the page is closed.
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
    exact: persisted?.exact === true,
  });

  const selection = new Selection({
    root: document,
    getViewportHeight: () => window.innerHeight,
    focusLine: settings.focus_line,
  });

  const hud = new Hud(document, {
    onSettings: () => toggleBindings(),
    onSpeed: (value) => {
      engine.setExactSpeed(value);
      rememberSpeed();
      paint();
    },
  });
  hud.mount();

  let mode = detectMode(window.location.pathname);
  let standby = loadStandby();
  let bindings = loadBindings();
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
      // Whichever side is handling keys right now: the daemon's config, or
      // the page's own bindings.
      bindings: daemonConnected ? settings.bindings : labelsOf(bindings),
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
    saveSpeed();
  }

  function showHelp(visible) {
    helpVisible = visible;
    if (helpTimer) {
      clearTimeout(helpTimer);
      helpTimer = null;
    }
    paint();
  }

  // `exact` goes with it: a typed speed may sit below the minimum, and the
  // next page has to know not to raise it.
  function saveSpeed() {
    persist({ speed: engine.speed, exact: engine.exact });
  }

  /** The user set a speed: keep it for this tab and for every new one. */
  function rememberSpeed() {
    saveSpeed();
    persistChosen({ speed: engine.speed, exact: engine.exact });
  }

  function scrollToSelected() {
    const element = selection.selectedElement;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const target = window.innerHeight * settings.focus_line;
    window.scrollBy(0, rect.top - target);
  }

  // The selected post in the feed; in a thread, the post itself.
  function galleryPost() {
    return mode === "feed"
      ? selection.selectedElement
      : document.querySelector("shreddit-post");
  }

  const ACTIONS = {
    toggleScroll() {
      engine.toggle();
      saveSpeed();
    },
    speedUp() {
      engine.adjustSpeed(settings.speed_step);
      rememberSpeed();
    },
    speedDown() {
      engine.adjustSpeed(-settings.speed_step);
      rememberSpeed();
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
    imagePrev() {
      stepGallery(galleryPost(), "prev");
    },
    imageNext() {
      stepGallery(galleryPost(), "next");
    },
    noop() {},
  };

  // The one gate both input paths pass through: the daemon's transport and
  // the in-page keydown fallback both arrive here. Dormant ignores everything
  // that touches the page; standby wakes it, and help only draws a panel.
  const ignoredOnStandby = (command) =>
    standby && command !== "standby" && command !== "help";

  function handleCommand(command) {
    if (ignoredOnStandby(command)) return;
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
      // While a speed is being typed, numpad digits are text. The daemon's
      // hook does not know about focus, so it still sends them as commands.
      // The page's own keys need no such check: a focused field gets them.
      if (hud.editing) return;
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
      panel.render();
    },
  });

  function setBindings(next) {
    bindings = next;
    saveBindings(bindings);
    paint();
  }

  const panel = new BindingsPanel(document, {
    rows: HELP_ORDER,
    getBindings: () => bindings,
    isDaemonConnected: () => daemonConnected,
    onAssign: (command, code, key) =>
      setBindings(assign(bindings, command, code, key)),
    onPreset: (name) => setBindings(fromPreset(name)),
    anchor: () => document.getElementById(HUD_ID),
  });

  function toggleBindings() {
    // The HUD's key list shows the same keys, and open it leaves the panel
    // no room above. Closed first, so the panel measures the shorter HUD.
    if (!panel.open) showHelp(false);
    panel.toggle();
  }

  try {
    GM_registerMenuCommand("Key bindings", toggleBindings);
  } catch {
    // The gear on the HUD opens it too.
  }

  function isTyping(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  }

  window.addEventListener("scroll", refresh, { passive: true });
  // Capture phase, on window: a bound key is stopped before Reddit's own
  // shortcuts or the page default (Space scrolling, say) can act on it.
  window.addEventListener(
    "keydown",
    (event) => {
      if (panel.handleKey(event)) return;
      // Keys typed into Reddit's search box are text, not commands.
      if (isTyping(event.target)) return;
      // The daemon's hook is global and fires regardless of window focus, so
      // when it is connected it already delivers this same keypress over the
      // transport. The page's own bindings are for when it is not running.
      if (daemonConnected) return;
      // Binding F must not cost the user Ctrl+F.
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const command = commandFor(bindings, event.code);
      // On standby the page gets its keys back, apart from the way out.
      if (!command || ignoredOnStandby(command)) return;
      event.preventDefault();
      event.stopPropagation();
      handleCommand(command);
    },
    true,
  );
  window.addEventListener("popstate", refresh);
  window.addEventListener("pagehide", saveSpeed);

  setInterval(() => transport.postState(snapshot()), 1000);

  refresh();
  transport.start();
}

boot();
