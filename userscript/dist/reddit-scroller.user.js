// ==UserScript==
// @name         Reddit Scroller
// @namespace    local.reddit-scroller
// @version      0.1.0
// @description  Hands-free Reddit scrolling driven by global hotkeys
// @match        https://www.reddit.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==
(() => {
  // src/commands.js
  function detectMode(pathname) {
    return pathname.includes("/comments/") ? "thread" : "feed";
  }
  var ACTIONS = {
    toggle: { feed: "toggleScroll", thread: "toggleScroll" },
    faster: { feed: "speedUp", thread: "speedUp" },
    slower: { feed: "speedDown", thread: "speedDown" },
    open: { feed: "openSelected", thread: "noop" },
    back: { feed: "noop", thread: "goBack" },
    next: { feed: "selectNext", thread: "pageDown" },
    prev: { feed: "selectPrev", thread: "pageUp" }
  };
  function resolveAction(command, mode) {
    const byMode = ACTIONS[command];
    if (!byMode) return "noop";
    return byMode[mode] || "noop";
  }
  var KEY_CODES = {
    Numpad0: "toggle",
    NumpadEnter: "open",
    NumpadDecimal: "back",
    NumpadAdd: "faster",
    NumpadSubtract: "slower",
    Numpad8: "prev",
    Numpad2: "next"
  };
  function commandForKeyCode(code) {
    return KEY_CODES[code] || null;
  }

  // src/selection.js
  var HIGHLIGHT_CLASS = "rs-selected";
  var POST_SELECTOR = "shreddit-post";
  function rankPosts(rects, focusY, viewportHeight) {
    let best = -1;
    let bestDistance = Infinity;
    rects.forEach((rect, index) => {
      if (rect.bottom <= 0 || rect.top >= viewportHeight) return;
      const distance = Math.abs(rect.top - focusY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }
  function readPosts(root) {
    return Array.from(root.querySelectorAll(POST_SELECTOR)).filter((element) => element.getAttribute("permalink")).map((element) => ({
      element,
      permalink: element.getAttribute("permalink"),
      title: element.getAttribute("post-title") || "",
      subreddit: element.getAttribute("subreddit-prefixed-name") || "",
      score: Number(element.getAttribute("score") || 0)
    }));
  }
  var Selection = class {
    constructor({ root, getViewportHeight, focusLine }) {
      this._root = root;
      this._getViewportHeight = getViewportHeight;
      this._focusLine = focusLine;
      this._posts = [];
      this._index = -1;
      this._pinned = null;
    }
    get count() {
      return this._posts.length;
    }
    get focusLine() {
      return this._focusLine;
    }
    setFocusLine(fraction) {
      this._focusLine = fraction;
    }
    get selectedElement() {
      const post = this._posts[this._index];
      return post ? post.element : null;
    }
    get selected() {
      const post = this._posts[this._index];
      if (!post) return null;
      const { permalink, title, subreddit, score } = post;
      return { permalink, title, subreddit, score };
    }
    refresh() {
      this._posts = readPosts(this._root);
      if (this._posts.length === 0) {
        this._index = -1;
        return;
      }
      const viewportHeight = this._getViewportHeight();
      const rects = this._posts.map(
        (post) => post.element.getBoundingClientRect()
      );
      if (this._pinned !== null) {
        const pinnedIndex = this._posts.findIndex(
          (post) => post.permalink === this._pinned
        );
        const rect = rects[pinnedIndex];
        const stillVisible = rect && rect.bottom > 0 && rect.top < viewportHeight;
        if (stillVisible) {
          this._index = pinnedIndex;
          return;
        }
        this._pinned = null;
      }
      this._index = rankPosts(
        rects,
        viewportHeight * this._focusLine,
        viewportHeight
      );
    }
    move(delta) {
      if (this._posts.length === 0) return null;
      const from = this._index === -1 ? 0 : this._index;
      this._index = Math.min(
        this._posts.length - 1,
        Math.max(0, from + delta)
      );
      this._pinned = this._posts[this._index].permalink;
      return this.selectedElement;
    }
    applyHighlight() {
      const wanted = this.selectedElement;
      this._root.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((element) => {
        if (element !== wanted) element.classList.remove(HIGHLIGHT_CLASS);
      });
      if (wanted) wanted.classList.add(HIGHLIGHT_CLASS);
    }
  };

  // src/hud.js
  var HUD_ID = "rs-hud";
  var BAR_CELLS = 12;
  var STYLE_ID = "rs-style";
  var CSS = `
#${HUD_ID} {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483647;
  width: 320px;
  padding: 14px 16px;
  border-radius: 10px;
  background: rgba(16, 16, 20, 0.92);
  color: #f2f2f2;
  font: 500 17px/1.35 "Segoe UI", system-ui, sans-serif;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  user-select: none;
}
#${HUD_ID} .rs-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}
#${HUD_ID} .rs-status { font-weight: 700; letter-spacing: 0.04em; }
#${HUD_ID} .rs-running { color: #56d364; }
#${HUD_ID} .rs-paused { color: #e3b341; }
#${HUD_ID} .rs-online { color: #56d364; font-size: 14px; }
#${HUD_ID} .rs-offline { color: #f85149; font-size: 14px; }
#${HUD_ID} .rs-rule {
  height: 1px;
  margin: 9px 0;
  background: rgba(255, 255, 255, 0.16);
}
#${HUD_ID} .rs-bar {
  font-family: "Cascadia Mono", Consolas, monospace;
  letter-spacing: 1px;
  color: #58a6ff;
}
#${HUD_ID} .rs-mode { font-size: 14px; opacity: 0.65; letter-spacing: 0.08em; }
#${HUD_ID} .rs-sub { font-size: 14px; opacity: 0.75; }
#${HUD_ID} .rs-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
#${HUD_ID} .rs-flash { font-size: 14px; color: #58a6ff; min-height: 19px; }
.${HIGHLIGHT_CLASS} {
  outline: 3px solid #58a6ff !important;
  outline-offset: 2px;
  border-radius: 8px;
}
`;
  function formatHud(state) {
    const span = Math.max(1, state.speedMax - state.speedMin);
    const filled = Math.round(
      (state.speed - state.speedMin) / span * BAR_CELLS
    );
    const clamped = Math.min(BAR_CELLS, Math.max(0, filled));
    let subreddit = "";
    let title = "";
    if (state.mode === "feed") {
      if (state.selected) {
        subreddit = state.selected.subreddit;
        title = `\u201C${state.selected.title}\u201D`;
      } else {
        title = state.postCount === 0 ? "no posts detected" : "no post in focus";
      }
    }
    return {
      status: state.running ? "SCROLLING" : "PAUSED",
      statusClass: state.running ? "rs-running" : "rs-paused",
      speed: `${Math.round(state.speed)} px/s`,
      bar: "\u2593".repeat(clamped) + "\u2591".repeat(BAR_CELLS - clamped),
      mode: state.mode.toUpperCase(),
      subreddit,
      title,
      daemon: state.daemonConnected ? "daemon" : "no daemon",
      daemonClass: state.daemonConnected ? "rs-online" : "rs-offline",
      flash: state.lastCommand ? state.lastCommand.toUpperCase() : ""
    };
  }
  var Hud = class {
    constructor(doc) {
      this._doc = doc;
      this._root = null;
      this._nodes = null;
    }
    mount() {
      const existing = this._doc.getElementById(HUD_ID);
      if (existing) {
        this._root = existing;
        this._nodes = this._collect(existing);
        return;
      }
      if (!this._doc.getElementById(STYLE_ID)) {
        const style = this._doc.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        this._doc.head.appendChild(style);
      }
      const root = this._doc.createElement("div");
      root.id = HUD_ID;
      root.innerHTML = `
      <div class="rs-row">
        <span class="rs-status"></span>
        <span class="rs-daemon"></span>
      </div>
      <div class="rs-rule"></div>
      <div class="rs-row">
        <span class="rs-speed"></span>
        <span class="rs-bar"></span>
      </div>
      <div class="rs-mode"></div>
      <div class="rs-sub"></div>
      <div class="rs-title"></div>
      <div class="rs-flash"></div>
    `;
      this._doc.body.appendChild(root);
      this._root = root;
      this._nodes = this._collect(root);
    }
    _collect(root) {
      return {
        status: root.querySelector(".rs-status"),
        daemon: root.querySelector(".rs-daemon"),
        speed: root.querySelector(".rs-speed"),
        bar: root.querySelector(".rs-bar"),
        mode: root.querySelector(".rs-mode"),
        sub: root.querySelector(".rs-sub"),
        title: root.querySelector(".rs-title"),
        flash: root.querySelector(".rs-flash")
      };
    }
    render(state) {
      if (!this._nodes) return;
      const view = formatHud(state);
      const n = this._nodes;
      n.status.textContent = view.status;
      n.status.className = `rs-status ${view.statusClass}`;
      n.daemon.textContent = `\u25CF ${view.daemon}`;
      n.daemon.className = `rs-daemon ${view.daemonClass}`;
      n.speed.textContent = view.speed;
      n.bar.textContent = view.bar;
      n.mode.textContent = view.mode;
      n.sub.textContent = view.subreddit;
      n.title.textContent = view.title;
      n.flash.textContent = view.flash;
    }
    unmount() {
      if (this._root && this._root.parentNode) {
        this._root.parentNode.removeChild(this._root);
      }
      this._root = null;
      this._nodes = null;
    }
  };

  // src/scroll.js
  var MAX_FRAME_SECONDS = 0.1;
  function clampSpeed(speed, min, max) {
    if (Number.isNaN(speed)) return min;
    return Math.min(max, Math.max(min, speed));
  }
  var ScrollEngine = class {
    constructor({
      scrollBy,
      requestFrame,
      cancelFrame,
      speed,
      min,
      max,
      step
    }) {
      this._scrollBy = scrollBy;
      this._requestFrame = requestFrame;
      this._cancelFrame = cancelFrame;
      this._min = min;
      this._max = max;
      this._step = step;
      this._speed = clampSpeed(speed, min, max);
      this._running = false;
      this._frame = null;
      this._lastTimestamp = null;
      this._remainder = 0;
    }
    get running() {
      return this._running;
    }
    get speed() {
      return this._speed;
    }
    get step() {
      return this._step;
    }
    setSpeed(pxPerSecond) {
      this._speed = clampSpeed(pxPerSecond, this._min, this._max);
      this._remainder = 0;
      return this._speed;
    }
    adjustSpeed(delta) {
      return this.setSpeed(this._speed + delta);
    }
    /** Adopt limits reported by the daemon, re-clamping the current speed. */
    setLimits(min, max) {
      this._min = min;
      this._max = max;
      return this.setSpeed(this._speed);
    }
    start() {
      if (this._running) return true;
      this._running = true;
      this._lastTimestamp = null;
      this._remainder = 0;
      this._frame = this._requestFrame((t) => this.tick(t));
      return true;
    }
    stop() {
      if (!this._running) return false;
      this._running = false;
      if (this._frame !== null) this._cancelFrame(this._frame);
      this._frame = null;
      this._lastTimestamp = null;
      return false;
    }
    toggle() {
      return this._running ? this.stop() : this.start();
    }
    tick(timestampMs) {
      if (!this._running) return;
      if (this._lastTimestamp !== null) {
        const dt = Math.min(
          MAX_FRAME_SECONDS,
          (timestampMs - this._lastTimestamp) / 1e3
        );
        this._remainder += this._speed * dt;
        const whole = Math.trunc(this._remainder);
        if (whole !== 0) {
          this._remainder -= whole;
          this._scrollBy(whole);
        }
      }
      this._lastTimestamp = timestampMs;
      this._frame = this._requestFrame((t) => this.tick(t));
    }
  };

  // src/transport.js
  var MAX_BACKOFF_MS = 5e3;
  function nextBackoff(current) {
    if (!current) return 1e3;
    return Math.min(current * 2, MAX_BACKOFF_MS);
  }
  function gmRequest({ method, url, body }) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        data: body,
        headers: body ? { "Content-Type": "application/json" } : void 0,
        timeout: 4e4,
        onload: (r) => resolve({ status: r.status, text: r.responseText }),
        onerror: () => reject(new Error(`request to ${url} failed`)),
        ontimeout: () => reject(new Error(`request to ${url} timed out`))
      });
    });
  }
  var Transport = class {
    constructor({ port, request, sleep, onCommands, onConnectionChange }) {
      this._base = `http://127.0.0.1:${port}`;
      this._request = request;
      this._sleep = sleep;
      this._onCommands = onCommands;
      this._onConnectionChange = onConnectionChange;
      this._cursor = 0;
      this._backoff = 0;
      this._running = false;
      this._connected = null;
      this._settings = null;
    }
    get connected() {
      return this._connected;
    }
    get settings() {
      return this._settings;
    }
    stop() {
      this._running = false;
    }
    async start() {
      this._running = true;
      while (this._running) {
        try {
          if (this._settings === null) {
            const health = await this._json("GET", "/health");
            this._settings = health.settings || {};
          }
          const body = await this._json("GET", `/events?cursor=${this._cursor}`);
          this._setConnected(true);
          this._backoff = 0;
          if (typeof body.cursor === "number") this._cursor = body.cursor;
          const commands = (body.events || []).map((event) => event.command);
          if (commands.length) this._onCommands(commands);
        } catch {
          this._setConnected(false);
          if (!this._running) break;
          this._backoff = nextBackoff(this._backoff);
          await this._sleep(this._backoff);
        }
      }
    }
    async postState(state) {
      try {
        await this._request({
          method: "POST",
          url: `${this._base}/state`,
          body: JSON.stringify(state)
        });
      } catch {
      }
    }
    async _json(method, path) {
      const response = await this._request({
        method,
        url: `${this._base}${path}`
      });
      if (response.status !== 200) {
        throw new Error(`${path} returned ${response.status}`);
      }
      return JSON.parse(response.text);
    }
    _setConnected(value) {
      if (this._connected === value) return;
      this._connected = value;
      this._onConnectionChange(value);
    }
  };

  // src/main.js
  var PORT = 8765;
  var STATE_KEY = "rs-scroll-state";
  var FLASH_MS = 900;
  var DEFAULTS = {
    speed_min: 15,
    speed_max: 600,
    speed_step: 15,
    default_speed: 90,
    focus_line: 0.25
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
      step: settings.speed_step
    });
    const selection = new Selection({
      root: document,
      getViewportHeight: () => window.innerHeight,
      focusLine: settings.focus_line
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
        lastCommand
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
    const ACTIONS2 = {
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
      noop() {
      }
    };
    function handleCommand(command) {
      flash(command);
      (ACTIONS2[resolveAction(command, mode)] || ACTIONS2.noop)();
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
        if (document.hidden) return;
        commands.forEach(handleCommand);
      },
      onConnectionChange: (ok) => {
        daemonConnected = ok;
        if (ok && transport.settings) {
          Object.assign(settings, transport.settings);
          engine.setLimits(settings.speed_min, settings.speed_max);
          selection.setFocusLine(settings.focus_line);
        }
        paint();
      }
    });
    function isTyping(target) {
      if (!target) return false;
      if (target.isContentEditable) return true;
      return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
    }
    window.addEventListener("scroll", refresh, { passive: true });
    window.addEventListener("keydown", (event) => {
      if (isTyping(event.target)) return;
      const command = commandForKeyCode(event.code);
      if (command) handleCommand(command);
    });
    window.addEventListener("pagehide", savePosition);
    setInterval(() => transport.postState(snapshot()), 1e3);
    refresh();
    if (persisted?.running) engine.start();
    transport.start();
  }
  boot();
})();
