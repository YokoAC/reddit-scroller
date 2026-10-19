/** Entry point: wires the transport, scroll engine, selection and HUD together. */

import {
  assign,
  commandFor,
  fromCodes,
  fromPreset,
  labelsOf,
  parseStored,
  toCodes,
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

// Speed lives in two stores: sessionStorage keeps this tab's own across a
// navigation; GM storage the last one set anywhere, where a new tab starts.
// Whether we were scrolling is never remembered: a page must not start alone.
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

// Only for a user-set speed. The tab's speed is saved on every unload; storing
// that here too would make an untouched default "theirs", ending default_speed.
function persistChosen(state) {
  try {
    GM_setValue(SPEED_KEY, state);
  } catch {
    // It still applies in this tab.
  }
}

// Read from GM storage, editable where the manager shows the script: moving the
// port (as the daemon's "port in use" message says, via config.json) then needs
// no rebuild or reinstall, and the page no longer polls the old port.
function loadPort() {
  try {
    const stored = GM_getValue(PORT_KEY);
    if (stored === undefined || stored === null || stored === "") {
      // Seeded so the key is visible in the manager. This is the only write.
      GM_setValue(PORT_KEY, DEFAULT_PORT);
      return DEFAULT_PORT;
    }
    return normalisePort(stored);
  } catch {
    // A manager that withholds GM storage still gets a working script.
    return DEFAULT_PORT;
  }
}

// Standby is a preference, not scroll state, so it is safe to remember: it can
// only make the script do less. Seeded, like the port, to show in the manager.
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

// Not seeded: the panel edits these. `customised` says whether the user ever
// changed a key; until then the daemon keeps its own.
function loadBindings() {
  try {
    const stored = GM_getValue(BINDINGS_KEY);
    const customised = stored !== undefined && stored !== null && stored !== "";
    return { bindings: parseStored(stored), customised };
  } catch {
    return { bindings: fromPreset("numpad"), customised: false };
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
  let { bindings, customised } = loadBindings();
  // Whose keys the connected daemon is listening for:
  //   "panel"  - ours; it accepted them.
  //   "config" - its config.json's, which we show because we have none stored.
  //   "legacy" - its own, unknown to us: it predates POST /bindings or refused.
  //   null     - not connected, or not settled yet.
  let keySync = null;
  // Commands whose key the daemon cannot hook. The page handles those itself.
  let pageOnly = [];
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
      // The keys in effect. Only a daemon that keeps its own, unknown to us,
      // is described by what it reported instead.
      bindings: keySync === "legacy" ? settings.bindings : labelsOf(bindings),
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

  // Navigation always lands paused, so nothing is scrolled past before it is
  // read. Stop the engine too: the back-forward cache can restore a page
  // without re-running this script.
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
      // While a speed is typed, numpad digits are text, but the focus-blind daemon
      // hook still sends them. Page keys need no check: a focused field gets them.
      if (hud.editing) return;
      // Likewise a page text field: Backspace bound to "back" must not leave a
      // comment draft. Only while the page has focus: a field stays active after
      // alt-tab, and the keys must keep working then, which is the daemon's job.
      if (document.hasFocus() && isTyping(activeElement())) return;
      commands.forEach(handleCommand);
    },
    onConnectionChange: (ok) => {
      daemonConnected = ok;
      if (!ok) keySync = null;
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
      // refresh(), not paint(): the daemon's focus_line changes which post is
      // current; paint() alone left the old selection until the next scroll.
      // After the settings above, so with nothing stored the daemon's keys show.
      if (ok) syncKeys();
      refresh();
      panel.render();
    },
  });

  function setBindings(next) {
    bindings = next;
    customised = true;
    saveBindings(bindings);
    paint();
    syncKeys();
  }

  /** Settle whose keys the daemon listens for. Run on connect and on change. */
  async function syncKeys() {
    if (!daemonConnected) return;
    if (customised) {
      const result = await transport.postBindings(toCodes(bindings));
      if (!daemonConnected) return;
      keySync = result.ok ? "panel" : "legacy";
      pageOnly = result.unsupported;
    } else if (settings.binding_codes) {
      // Nothing of ours to send: config.json's keys stand, and we show them.
      bindings = fromCodes(settings.binding_codes);
      keySync = "config";
      pageOnly = [];
    } else {
      keySync = "legacy";
      pageOnly = [];
    }
    // refresh(), not paint(): on connect the selection is not yet recomputed for
    // the daemon's focus line, and both belong in the same frame.
    refresh();
    panel.render();
  }

  function bindingsNote() {
    if (keySync === "legacy") {
      return (
        "The daemon is using the keys in its config.json. " +
        "These apply when it is not running."
      );
    }
    if (keySync === "config") {
      return (
        "These are the keys from the daemon's config.json. " +
        "Change one here and this panel takes over."
      );
    }
    if (keySync === "panel" && pageOnly.length) {
      const names = HELP_ORDER.filter(([command]) => pageOnly.includes(command))
        .map(([, description]) => description)
        .join(", ");
      return `The daemon cannot listen for the key set for: ${names}. It works while the browser has focus.`;
    }
    return null;
  }

  const panel = new BindingsPanel(document, {
    rows: HELP_ORDER,
    getBindings: () => bindings,
    getNote: bindingsNote,
    onAssign: (command, code, key) =>
      setBindings(assign(bindings, command, code, key)),
    onPreset: (name) => setBindings(fromPreset(name)),
    anchor: () => document.getElementById(HUD_ID),
  });

  function toggleBindings() {
    // The HUD's key list shows the same keys and leaves the panel no room above:
    // close it first, so the panel measures the shorter HUD.
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

  /** The focused element, looking through open shadow roots for it. */
  function activeElement() {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) {
      element = element.shadowRoot.activeElement;
    }
    return element;
  }

  window.addEventListener("scroll", refresh, { passive: true });
  // Capture phase, on window: a bound key is stopped before Reddit's own
  // shortcuts or the page default (Space scrolling, say) can act on it.
  window.addEventListener(
    "keydown",
    (event) => {
      if (panel.handleKey(event)) return;
      // Keys typed into Reddit's search box are text. Composed path: its fields sit
      // in shadow roots, so the target seen from here is only their host.
      if (isTyping(event.composedPath?.()[0] ?? event.target)) return;
      // Binding F must not cost the user Ctrl+F.
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const command = commandFor(bindings, event.code);
      // On standby the page gets its keys back, apart from the way out.
      if (!command || ignoredOnStandby(command)) return;
      // A daemon keeping its own keys: ours mean nothing while it is
      // connected, so the key is left entirely alone.
      const synced = keySync === "panel" || keySync === "config";
      if (daemonConnected && !synced) return;
      event.preventDefault();
      event.stopPropagation();
      // The focus-blind daemon hook already sends this press; acting here too
      // would run it twice. Unless it is a key the daemon cannot hook.
      if (daemonConnected && !pageOnly.includes(command)) return;
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
