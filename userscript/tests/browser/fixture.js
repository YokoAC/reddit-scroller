/**
 * The harness the cross-browser specs share. They answer what the jsdom suites
 * cannot: does the shipped bundle behave the same in Chrome as in Firefox? So
 * they run the real bundle, compiled from src, in a real engine against the
 * real daemon, with the same two stand-ins as the cross-half integration suite:
 *
 * - The keyboard hook: command names written to the daemon's stdin, as in
 *   tests/integration/wire.test.js, the same seam the hook uses.
 * - `GM_xmlhttpRequest`: an exposed binding that fetches from Node. Close to the
 *   real one, which also runs outside the page in the manager's privileged
 *   context, hence free of CORS and mixed-content blocking. It cannot reproduce
 *   a browser's own policy on extension traffic to loopback (see the README's
 *   browser-support note).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { BUILD_TARGET } from "../../build-target.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USERSCRIPT_ROOT = path.resolve(HERE, "../..");
const REPO_ROOT = path.resolve(USERSCRIPT_ROOT, "..");

// Run the venv's interpreter directly rather than through `uv run`, which
// spawns Python as a grandchild -- kill() would then terminate uv and leave
// the daemon holding its port. Learned the hard way in wire.test.js.
const PYTHON =
  process.platform === "win32"
    ? path.join(REPO_ROOT, ".venv", "Scripts", "python.exe")
    : path.join(REPO_ROOT, ".venv", "bin", "python");

// Clear of the daemon's 8765, the Python suite's 8797-8799 and the cross-half
// suite's 8810+. Each worker gets its own decade, so parallel browser projects
// never share a socket.
const PORT_BASE = 8830;
const POLL_TIMEOUT = "2.0";

export const POSTS = [
  {
    permalink: "/r/python/comments/aaa/type_hints/",
    title: "Type hints finally paid off",
    subreddit: "r/python",
    score: 4812,
  },
  {
    permalink: "/r/gamedev/comments/bbb/shader_notes/",
    title: "Notes from a week of shader debugging",
    subreddit: "r/gamedev",
    score: 932,
  },
  {
    permalink: "/r/rust/comments/ccc/borrow_checker/",
    title: "The borrow checker is a teacher",
    subreddit: "r/rust",
    score: 15400,
  },
  {
    permalink: "/r/webdev/comments/ddd/css_grid/",
    title: "CSS grid solved a layout I gave up on",
    subreddit: "r/webdev",
    score: 271,
  },
  {
    permalink: "/r/linux/comments/eee/wayland/",
    title: "Wayland on an old laptop",
    subreddit: "r/linux",
    score: 88,
  },
  {
    permalink: "/r/emacs/comments/fff/org_mode/",
    title: "Org mode as a build system",
    subreddit: "r/emacs",
    score: 1203,
  },
];

let bundlePromise = null;

/**
 * The bundle, compiled from src rather than read from dist/ -- so these tests
 * can never pass against a stale build.
 */
export function bundle() {
  if (!bundlePromise) {
    bundlePromise = build({
      entryPoints: [path.join(USERSCRIPT_ROOT, "src", "main.js")],
      bundle: true,
      format: "iife",
      target: BUILD_TARGET,
      write: false,
    }).then((result) => result.outputFiles[0].text);
  }
  return bundlePromise;
}

/** Markup shaped like Reddit's: the attributes selection.js reads, and height. */
export function feedHtml(port) {
  const posts = POSTS.map(
    (post) => `
      <shreddit-post
        permalink="${post.permalink}"
        post-title="${post.title}"
        subreddit-prefixed-name="${post.subreddit}"
        score="${post.score}">
        <div class="sub">${post.subreddit}</div>
        <h2>${post.title}</h2>
        <p>${post.score} points</p>
      </shreddit-post>`,
  ).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>fixture feed (daemon ${port})</title>
  <style>
    body { margin: 0; background: #0b0b0e; color: #ddd;
           font: 16px system-ui, sans-serif; }
    shreddit-post { display: block; margin: 18px auto; width: 640px;
                    min-height: 420px; padding: 20px; box-sizing: border-box;
                    background: #17171c; border-radius: 8px; }
    .sub { color: #58a6ff; font-size: 14px; }
    h2 { margin: 6px 0 12px; font-size: 22px; }
  </style>
</head>
<body>
  <h1 style="text-align:center">fixture feed</h1>
  ${posts}
</body>
</html>`;
}

/** A running daemon: the real EventBus and aiohttp app, minus the hook. */
class Daemon {
  constructor(process_, port) {
    this._process = process_;
    this.port = port;
  }

  /** Deliver a command, as the keyboard hook's thread would. */
  send(command) {
    this._process.stdin.write(`${command}\n`);
  }

  async stop() {
    if (this._process.exitCode !== null) return;
    const exited = new Promise((resolve) =>
      this._process.once("exit", resolve),
    );
    this._process.kill();
    await exited;
  }
}

export function startDaemon(port, pollTimeout = POLL_TIMEOUT) {
  const child = spawn(
    PYTHON,
    ["-m", "tests.support.integration_daemon", String(port), pollTimeout],
    { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] },
  );

  return new Promise((resolve, reject) => {
    const fail = (error) => {
      child.kill();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error(`daemon on ${port} never reported ready`)),
      20000,
    );
    child.stdout.on("data", (chunk) => {
      if (!String(chunk).includes("READY")) return;
      clearTimeout(timer);
      resolve(new Daemon(child, port));
    });
    child.on("error", fail);
  });
}

let portOffset = 0;

/**
 * A port this worker alone uses, a new one per test: a just-killed daemon can
 * hold its socket briefly, and the next test must not wait for it.
 */
export function nextPort(testInfo) {
  return PORT_BASE + testInfo.workerIndex * 100 + portOffset++;
}

/**
 * Give the page everything a userscript manager would: the bundle on every
 * navigation, and a GM_xmlhttpRequest that runs outside the page.
 */
export async function preparePage(page, port) {
  await page.exposeFunction("__rsRequest", async ({ method, url, body }) => {
    const response = await fetch(url, {
      method,
      body,
      headers: body ? { "Content-Type": "application/json" } : undefined,
    });
    return { status: response.status, text: await response.text() };
  });

  // GM storage, seeded with this test's port: each test reaches its own daemon
  // as a reader moving off 8765 would, by a manager value, nothing rebuilt.
  await page.addInitScript((seedPort) => {
    const store = new Map([["rs-port", seedPort]]);
    window.GM_getValue = (key, fallback) =>
      store.has(key) ? store.get(key) : fallback;
    window.GM_setValue = (key, value) => store.set(key, value);

    window.GM_xmlhttpRequest = (options) => {
      window
        .__rsRequest({
          method: options.method,
          url: options.url,
          body: options.data,
        })
        .then((result) => {
          options.onload?.({
            status: result.status,
            responseText: result.text,
          });
        })
        .catch(() => options.onerror?.());
    };
  }, port);

  const code = await bundle();
  // Re-injected on every navigation, as a manager does, and deferred to
  // DOMContentLoaded like the banner's @run-at document-idle: main.js reads the
  // document as soon as it runs.
  await page.addInitScript({
    content: `(function () {
  var run = function () {
${code}
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();`,
  });

  // Every reddit.com URL resolves to the fixture, so opening a post exercises
  // thread mode against a real pathname rather than a contrived one.
  await page.route("https://www.reddit.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: feedHtml(port) }),
  );
}
