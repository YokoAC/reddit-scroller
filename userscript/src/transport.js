/**
 * Long-poll transport to the local daemon. Not a WebSocket: ws:// from an
 * https:// page is mixed content, and managers do not proxy sockets.
 * GM_xmlhttpRequest runs privileged, and a held GET is just as fast here.
 */

const MAX_BACKOFF_MS = 5000;

/** What the daemon binds unless config.json says otherwise. */
export const DEFAULT_PORT = 8765;

/**
 * Coerce a stored port into something usable. Users edit it by hand in the
 * manager, so it can be anything, even empty: an unusable value falls back to
 * the default rather than throwing, so a running daemon stays reachable.
 */
export function normalisePort(raw) {
  const port = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_PORT;
  return port;
}

export function nextBackoff(current) {
  if (!current) return 1000;
  return Math.min(current * 2, MAX_BACKOFF_MS);
}

/** Adapter turning GM_xmlhttpRequest's callback API into a promise. */
export function gmRequest({ method, url, body }) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method,
      url,
      data: body,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      timeout: 40000,
      onload: (r) => resolve({ status: r.status, text: r.responseText }),
      onerror: () => reject(new Error(`request to ${url} failed`)),
      ontimeout: () => reject(new Error(`request to ${url} timed out`)),
    });
  });
}

export class Transport {
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
          // Start at the daemon's current position: replaying the backlog would re-run
          // navigation and throw the reader back where they were.
          if (typeof health.cursor === "number") this._cursor = health.cursor;
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
        body: JSON.stringify(state),
      });
    } catch {
      // The daemon being down is normal and already shown in the HUD.
    }
  }

  /**
   * Send the page's key bindings for the daemon to listen for. Never throws:
   * `ok` is false for a daemon that is down, predates the endpoint, or
   * refuses, and the caller then leaves the daemon to its own keys.
   */
  async postBindings(codes) {
    const failed = { ok: false, unsupported: [] };
    try {
      const response = await this._request({
        method: "POST",
        url: `${this._base}/bindings`,
        body: JSON.stringify({ bindings: codes }),
      });
      if (response.status !== 200) return failed;
      const body = JSON.parse(response.text);
      if (body.ok !== true) return failed;
      return {
        ok: true,
        unsupported: Array.isArray(body.unsupported) ? body.unsupported : [],
      };
    } catch {
      return failed;
    }
  }

  async _json(method, path) {
    const response = await this._request({
      method,
      url: `${this._base}${path}`,
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
}
