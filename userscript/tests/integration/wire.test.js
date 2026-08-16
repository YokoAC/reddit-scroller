/**
 * Cross-half integration tests.
 *
 * Every user-visible bug in this project so far has lived in the seam between
 * the two halves rather than inside either one: a fresh page replaying the
 * daemon's whole backlog, a page stalling after a daemon restart, and the
 * settings contract. Both halves were well covered in isolation -- each
 * against a hand-written stub of the other, which is precisely how the
 * contract drifted twice with every test still green.
 *
 * These tests run the real aiohttp server and the real Transport against each
 * other over real HTTP. The only substitution is the keyboard hook, which is
 * replaced by writing command names to the daemon's stdin -- the same seam,
 * and the same bus method, the hook itself uses.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Transport } from "../../src/transport.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

// Well clear of the daemon's default 8765 and of the fixed ports the Python
// suite binds (8797-8799). Each daemon takes the next port so a stopped one
// releasing its socket can never collide with the next test starting.
let nextPort = 8810;
const POLL_TIMEOUT = "2.0";

// Run the venv's interpreter directly rather than going through `uv run`.
// `uv run` spawns Python as a grandchild, so kill() would terminate uv and
// leave the daemon orphaned -- holding its port and its connections open.
// Verified: that leaked one live daemon per test.
const PYTHON =
  process.platform === "win32"
    ? path.join(REPO_ROOT, ".venv", "Scripts", "python.exe")
    : path.join(REPO_ROOT, ".venv", "bin", "python");

/** A real HTTP client, standing in for the GM_xmlhttpRequest adapter. */
async function request({ method, url, body }) {
  const response = await fetch(url, {
    method,
    body,
    headers: body ? { "Content-Type": "application/json" } : undefined,
  });
  return { status: response.status, text: await response.text() };
}

class Daemon {
  static async start() {
    const daemon = new Daemon();
    daemon.port = nextPort++;
    daemon._exited = false;
    daemon._process = spawn(
      PYTHON,
      [
        "-m",
        "tests.support.integration_daemon",
        String(daemon.port),
        POLL_TIMEOUT,
      ],
      { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
    daemon._process.on("exit", () => {
      daemon._exited = true;
    });

    daemon._stderr = "";
    daemon._process.stderr.on("data", (chunk) => {
      daemon._stderr += chunk.toString();
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `daemon did not become ready in 30s. stderr:\n${daemon._stderr}`,
            ),
          ),
        30000,
      );
      daemon._process.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      daemon._process.on("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(`daemon exited with ${code}. stderr:\n${daemon._stderr}`),
        );
      });
    });
    return daemon;
  }

  /** Stands in for a physical keypress reaching the global hook. */
  press(...commands) {
    for (const command of commands) {
      this._process.stdin.write(`${command}\n`);
    }
  }

  /** Idempotent: some tests stop the daemon themselves, then afterEach runs. */
  async stop() {
    if (this._exited) return;
    const exited = new Promise((resolve) =>
      this._process.once("exit", resolve),
    );
    this._process.kill();
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
}

function makeTransport({ onCommands = () => {}, port = daemon.port } = {}) {
  return new Transport({
    port,
    request,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onCommands,
    onConnectionChange: () => {},
  });
}

/** Poll until `predicate` holds, so tests never race the network. */
async function until(predicate, { timeout = 8000, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let daemon;

beforeEach(async () => {
  daemon = await Daemon.start();
});

afterEach(async () => {
  await daemon?.stop();
});

describe("a page joining a daemon that has been running a while", () => {
  it("receives no backlog, however much has already happened", async () => {
    // The bug the user actually hit: a fresh page polled from cursor 0 and the
    // daemon replayed its entire retained log, re-running navigation commands.
    daemon.press("faster", "faster", "prev", "back", "open", "toggle");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const received = [];
    const transport = makeTransport({
      onCommands: (commands) => received.push(...commands),
    });
    transport.start();

    await until(() => transport.connected, { label: "the first poll" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    transport.stop();

    expect(received).toEqual([]);
  });

  it("still receives everything that happens after it joins", async () => {
    daemon.press("open", "back"); // backlog it must not see
    await new Promise((resolve) => setTimeout(resolve, 300));

    const received = [];
    const transport = makeTransport({
      onCommands: (commands) => received.push(...commands),
    });
    transport.start();
    await until(() => transport.connected, { label: "connection" });

    daemon.press("toggle", "faster", "next");
    await until(() => received.length >= 3, { label: "three commands" });
    transport.stop();

    expect(received).toEqual(["toggle", "faster", "next"]);
  });
});

describe("the long poll", () => {
  it("delivers a command promptly rather than at the timeout", async () => {
    const received = [];
    const transport = makeTransport({
      onCommands: (commands) => received.push(...commands),
    });
    transport.start();
    await until(() => transport.connected, { label: "connection" });

    const sentAt = Date.now();
    daemon.press("toggle");
    await until(() => received.length === 1, { label: "the command" });
    const elapsed = Date.now() - sentAt;
    transport.stop();

    // The server holds the request for POLL_TIMEOUT seconds when idle; arriving
    // far inside that proves the waiter woke on the append.
    expect(elapsed).toBeLessThan(1000);
  });

  it("keeps delivering across an idle timeout", async () => {
    const received = [];
    const transport = makeTransport({
      onCommands: (commands) => received.push(...commands),
    });
    transport.start();
    await until(() => transport.connected, { label: "connection" });

    // Outlast one full poll timeout with nothing happening.
    await new Promise((resolve) => setTimeout(resolve, 2600));
    daemon.press("slower");
    await until(() => received.length === 1, { label: "post-timeout command" });
    transport.stop();

    expect(received).toEqual(["slower"]);
  });
});

describe("a page that outlived a daemon restart", () => {
  it("resyncs instead of stalling when its cursor is ahead", async () => {
    // The tab's cursor is from the previous daemon's sequence, which the fresh
    // one has not reached. Without a resync it ignores commands indefinitely.
    const received = [];
    const transport = makeTransport({
      onCommands: (commands) => received.push(...commands),
    });
    transport._cursor = 500; // as if left over from a long previous session
    transport._settings = {}; // and already past its /health fetch
    transport.start();

    await until(() => transport.connected, { label: "connection" });
    daemon.press("toggle");
    await until(() => received.length === 1, {
      label: "a command after resync",
    });
    transport.stop();

    expect(received).toEqual(["toggle"]);
  });
});

describe("the settings contract", () => {
  it("carries every field the page reads off it", async () => {
    const transport = makeTransport();
    transport.start();
    await until(() => transport.settings !== null, { label: "settings" });
    transport.stop();

    const settings = transport.settings;
    // main.js merges these into its DEFAULTS and reads each one by name.
    for (const key of [
      "speed_min",
      "speed_max",
      "speed_step",
      "default_speed",
      "focus_line",
    ]) {
      expect(typeof settings[key], `${key} should be a number`).toBe("number");
    }
    expect(settings.speed_min).toBeLessThan(settings.speed_max);
  });

  it("names a key for every command the router can resolve", async () => {
    const transport = makeTransport();
    transport.start();
    await until(() => transport.settings !== null, { label: "settings" });
    transport.stop();

    // If the daemon grows a command the userscript cannot route, or the
    // userscript advertises one the daemon never sends, this catches it.
    expect(Object.keys(transport.settings.bindings).sort()).toEqual(
      [
        "back",
        "faster",
        "help",
        "next",
        "open",
        "prev",
        "reverse",
        "slower",
        "toggle",
      ].sort(),
    );
  });
});

describe("state reporting", () => {
  it("round-trips a snapshot back to the daemon", async () => {
    const transport = makeTransport();
    transport.start();
    await until(() => transport.connected, { label: "connection" });

    await transport.postState({ running: true, speed: 135, mode: "feed" });
    const response = await request({
      method: "GET",
      url: `http://127.0.0.1:${daemon.port}/state`,
    });
    transport.stop();

    expect(JSON.parse(response.text)).toMatchObject({
      running: true,
      speed: 135,
      mode: "feed",
    });
  });
});

describe("when the daemon goes away", () => {
  it("reports the connection lost and keeps retrying", async () => {
    const changes = [];
    const transport = new Transport({
      port: daemon.port,
      request,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      onCommands: () => {},
      onConnectionChange: (ok) => changes.push(ok),
    });
    transport.start();
    await until(() => transport.connected, { label: "connection" });

    await daemon.stop();
    await until(() => transport.connected === false, {
      label: "the connection to drop",
    });
    transport.stop();

    expect(changes[0]).toBe(true);
    expect(changes.at(-1)).toBe(false);
  });
});
