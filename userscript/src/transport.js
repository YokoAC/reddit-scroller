/**
 * Long-poll transport to the local daemon.
 *
 * A WebSocket would be the obvious choice, but ws:// from an https:// page is
 * mixed content and userscript managers do not proxy sockets. GM_xmlhttpRequest
 * runs in the manager's privileged context, so a held GET is both allowed and
 * fast enough to be indistinguishable from a socket here.
 */

const MAX_BACKOFF_MS = 5000;

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
          // Begin at the daemon's current position. A page that has just
          // loaded must not be handed the backlog: replaying old commands
          // re-runs navigation and throws the reader back where they were.
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
