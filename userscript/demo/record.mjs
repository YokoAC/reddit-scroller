/**
 * Records the README demo video: demo/out/demo.mp4.
 *
 * The real bundle against the hookless daemon (tests/support), in Chromium. A
 * stand-in game is the parent page and never reloads; a mock Reddit feed is an
 * iframe beside it. Needs `uv sync`, `npx playwright install chromium`, and uv
 * for a temporary ffmpeg (imageio-ffmpeg, never added to the project).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { bundle, startDaemon } from "../tests/browser/fixture.js";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
const PORT = 8899;
const W = 1280;
const H = 720;

// [subreddit, title, score, comments, image colours or null for a text post]
const FEED = [
  [
    "r/pcgaming",
    "Finally finished my dual-monitor setup",
    18200,
    412,
    ["#1d3557", "#457b9d", "#a8dadc"],
  ],
  [
    "r/EarthPorn",
    "Sunrise over the Dolomites [4000x2667]",
    30100,
    588,
    ["#ff7e5f", "#feb47b", "#3a1c71"],
  ],
  [
    "r/programming",
    "What I learned rewriting our build in a weekend",
    2950,
    301,
    null,
  ],
  [
    "r/aww",
    "He insists on supervising every match",
    41200,
    960,
    ["#c79081", "#dfa579", "#5d4157"],
  ],
  [
    "r/space",
    "JWST's newest deep field, annotated",
    22800,
    733,
    ["#0f0c29", "#302b63", "#24243e"],
  ],
  ["r/todayilearned", "TIL octopuses taste with their arms", 15400, 1204, null],
  [
    "r/gaming",
    "The level design in this boss fight is unreal",
    9800,
    655,
    ["#134e5e", "#71b280", "#0b2027"],
  ],
  [
    "r/interestingasfuck",
    "A city built entirely on stilts",
    27600,
    845,
    ["#2c3e50", "#fd746c", "#ff9068"],
  ],
  [
    "r/cooking",
    "Two years of chasing the perfect ramen broth",
    6100,
    390,
    ["#8e2de2", "#f2994a", "#4a00e0"],
  ],
  [
    "r/worldnews",
    "New rail tunnel opens a year ahead of schedule",
    12400,
    1532,
    null,
  ],
  [
    "r/pics",
    "My grandfather's workshop, untouched since 1974",
    35800,
    1102,
    ["#3e5151", "#decba4", "#2b2b2b"],
  ],
  [
    "r/mechanicalkeyboards",
    "Numpad-only build for my sim rig",
    4400,
    278,
    ["#232526", "#414345", "#ff512f"],
  ],
  [
    "r/Showerthoughts",
    "A numpad is just a tiny piano for spreadsheets",
    21900,
    870,
    null,
  ],
  [
    "r/oddlysatisfying",
    "Restoring a rusted cast-iron pan",
    18800,
    512,
    ["#614385", "#516395", "#c9d6ff"],
  ],
];

const COMMENTS = [
  "This is the content I'm here for.",
  "Saving this for later, great write-up.",
  "How long did this take you?",
  "Underrated post, honestly.",
  "The details are what make it.",
];

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 30);
const permalink = (p, i) => `/${p[0]}/comments/d${i}/${slug(p[1])}/`;
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function art(colors, i) {
  if (!colors) return "";
  const [a, b, c] = colors;
  const x = 20 + ((i * 37) % 60);
  return `<div class="img" style="background:
    radial-gradient(circle at ${x}% 30%, ${c} 0 12%, transparent 13%),
    linear-gradient(160deg, ${a}, ${b})">
    <div class="hill" style="background:${c}"></div></div>`;
}

function postHtml(p, i, full) {
  const text = `<p class="text">${"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ".repeat(3)}</p>`;
  return `<shreddit-post permalink="${permalink(p, i)}" post-title="${p[1]}"
      subreddit-prefixed-name="${p[0]}" score="${p[2]}" class="${full ? "full" : ""}">
    <div class="meta"><span class="dot" style="background:hsl(${i * 47} 70% 55%)"></span>
      <b>${p[0]}</b> · ${2 + (i % 9)}h</div>
    <h2>${p[1]}</h2>
    ${art(p[4], i) || text}
    <div class="bar"><span>⬆ ${k(p[2])} ⬇</span><span>💬 ${k(p[3])}</span><span>↗ Share</span></div>
  </shreddit-post>`;
}

const commentsHtml = Array.from(
  { length: 14 },
  (_, i) => `<div class="comment" style="margin-left:${(i % 3) * 22}px">
    <b>u/reader_${100 + i * 7}</b> · ${k(900 - i * 55)} points
    <p>${COMMENTS[i % COMMENTS.length]}</p></div>`,
).join("");

function redditHtml(pathname) {
  let body;
  if (pathname.includes("/comments/")) {
    const i = FEED.findIndex((p, j) => pathname === permalink(p, j));
    body = `<div class="back">← r/${FEED[i][0].slice(2)}</div>
      ${postHtml(FEED[i], i, true)}<div class="comments">${commentsHtml}</div>`;
  } else {
    body = FEED.map((p, i) => postHtml(p, i, false)).join("");
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>reddit</title><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #0e1113; color: #d7dadc; font: 15px/1.4 system-ui, sans-serif; }
  main { padding: 52px 0 400px; }
  shreddit-post { display: block; width: 560px; margin: 0 auto 14px; padding: 12px 16px;
                  background: #0e1113; border-bottom: 1px solid #343536; border-radius: 6px; }
  .meta { font-size: 12px; color: #818384; display: flex; align-items: center; gap: 6px; }
  .meta b { color: #d7dadc; }
  .dot { width: 18px; height: 18px; border-radius: 50%; display: inline-block; }
  h2 { font-size: 18px; margin: 6px 0 10px; color: #f2f4f5; }
  .img { height: 300px; border-radius: 14px; position: relative; overflow: hidden; }
  .full .img { height: 340px; }
  .hill { position: absolute; left: -10%; right: -10%; bottom: -60%; height: 100%;
          border-radius: 50%; opacity: .55; }
  .text { color: #b8babc; margin: 0; }
  .bar { display: flex; gap: 10px; margin-top: 10px; font-size: 13px; }
  .bar span { background: #272729; border-radius: 14px; padding: 4px 12px; }
  .back, .comments { width: 560px; margin: 0 auto 8px; color: #818384; }
  .comment { border-left: 2px solid #343536; padding: 6px 12px; margin-bottom: 12px;
             color: #818384; font-size: 13px; }
  .comment p { color: #d7dadc; margin: 4px 0 0; font-size: 14px; }
  </style></head><body><main>${body}</main></body></html>`;
}

const STAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>demo</title><style>
  body { margin: 0; background: #000; overflow: hidden; }
  canvas { position: fixed; left: 0; top: 0; }
  iframe { position: fixed; left: 646px; top: 0; width: 634px; height: 720px; border: 0; }
  #split { position: fixed; left: 640px; top: 0; width: 6px; height: 720px; background: #1a1a1a; }
  .label { position: fixed; top: 12px; z-index: 6; font: 600 13px system-ui; letter-spacing: .06em;
           padding: 5px 10px; border-radius: 6px; background: #000c; }
  #focus { left: 12px; color: #7ee787; border: 1px solid #7ee78788; }
  #mon2 { left: 658px; color: #aaa; border: 1px solid #555; }
  #key { position: fixed; left: 320px; bottom: 34px; transform: translateX(-50%); z-index: 7;
         display: flex; gap: 12px; align-items: center; opacity: 0; transition: opacity .2s;
         background: #000c; padding: 10px 16px; border-radius: 12px; border: 1px solid #333; }
  #key.on { opacity: 1; }
  #key .cap { font: 700 20px system-ui; color: #111; background: linear-gradient(#f4f4f4, #c9c9c9);
              border-radius: 8px; padding: 8px 12px; box-shadow: 0 3px 0 #888; min-width: 44px;
              text-align: center; }
  #key .what { font: 600 18px system-ui; color: #fff; }
  #card { position: fixed; inset: 0; z-index: 9; background: #0b0d10; color: #fff; display: flex;
          flex-direction: column; align-items: center; justify-content: center; gap: 14px;
          text-align: center; transition: opacity .35s; }
  #card.gone { opacity: 0; }
  #card h1 { font: 800 52px system-ui; margin: 0; }
  #card h1 span { color: #ff4500; }
  #card p { font: 22px system-ui; color: #aab; margin: 0; max-width: 900px; }
  #card .url { font: 600 20px ui-monospace, monospace; color: #58a6ff; }
</style></head><body>
  <canvas width="640" height="720"></canvas><div id="split"></div>
  <iframe src="https://www.reddit.com/"></iframe>
  <div class="label" id="focus">MONITOR 1 · GAME · HAS FOCUS</div>
  <div class="label" id="mon2">MONITOR 2 · REDDIT</div>
  <div id="key"><span class="cap"></span><span class="what"></span></div>
  <div id="card"><h1>Reddit <span>Scroller</span></h1>
    <p>Auto-scroll Reddit on your second monitor, with numpad hotkeys that work while a game has focus.</p></div>
<script>
  const g = document.querySelector("canvas").getContext("2d");
  const stars = Array.from({ length: 160 }, (_, i) => [(i * 7919) % 640, (i * 104729) % 720, 1 + (i % 3)]);
  const t0 = performance.now();
  function draw() {
    const t = (performance.now() - t0) / 1000;
    g.fillStyle = "#05060f"; g.fillRect(0, 0, 640, 720);
    for (const [x, y, z] of stars) {
      g.fillStyle = "rgba(200,220,255," + (0.3 + z * 0.2) + ")";
      g.fillRect(x, (y + t * 60 * z) % 720, z, z * 3);
    }
    const sx = 320 + Math.sin(t * 1.3) * 160, sy = 560 + Math.sin(t * 2.1) * 20;
    g.fillStyle = "#ff4500"; g.beginPath();
    g.moveTo(sx, sy - 34); g.lineTo(sx - 24, sy + 22); g.lineTo(sx + 24, sy + 22); g.fill();
    g.fillStyle = "#ffd166"; g.fillRect(sx - 6, sy + 22, 12, 10 + Math.random() * 14);
    for (let i = 0; i < 4; i++) {
      const ex = 320 + Math.sin(t * 0.7 + i * 1.7) * 230, ey = ((t * 90 + i * 180) % 820) - 100;
      g.fillStyle = "#58a6ff"; g.beginPath(); g.arc(ex, ey, 16, 0, 7); g.fill();
    }
    g.fillStyle = "#fff"; g.font = "600 18px system-ui";
    g.fillText("SCORE " + Math.floor(t * 137), 24, 70);
    requestAnimationFrame(draw);
  }
  draw();
  window.__key = (cap, what) => {
    const el = document.getElementById("key");
    el.querySelector(".cap").textContent = cap;
    el.querySelector(".what").textContent = what;
    el.classList.add("on");
    clearTimeout(window.__kt);
    window.__kt = setTimeout(() => el.classList.remove("on"), 1500);
  };
  window.__card = (html) => {
    const c = document.getElementById("card");
    if (html) { c.innerHTML = html; c.classList.remove("gone"); } else c.classList.add("gone");
  };
</script></body></html>`;

const END_CARD = `<h1>Reddit <span>Scroller</span></h1>
  <p>Userscript for Firefox &amp; Chrome · optional Windows daemon for global hotkeys · rebindable keys</p>
  <div class="url">github.com/YokoAC/reddit-scroller</div>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ffmpeg() {
  const exe = execFileSync(
    "uv",
    [
      "run",
      "--no-project",
      "--with",
      "imageio-ffmpeg",
      "python",
      "-c",
      "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())",
    ],
    { encoding: "utf8" },
  );
  return exe.trim().split("\n").at(-1).trim();
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// A 0.25s poll: a page counts as connected once its first poll returns, so a
// new page reconnects within a frame or two rather than two seconds.
const daemon = await startDaemon(PORT, "0.25");
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: OUT, size: { width: W, height: H } },
});
const page = await context.newPage();
const t0 = Date.now();
const at = () => (Date.now() - t0) / 1000;

await page.exposeFunction("__rsRequest", async ({ method, url, body }) => {
  const response = await fetch(url, {
    method,
    body,
    headers: body ? { "Content-Type": "application/json" } : undefined,
  });
  return { status: response.status, text: await response.text() };
});
// What a manager does, in the Reddit frame only. The auto-shown key list is
// hidden: it would cover the feed, and the demo never asks for it.
await page.addInitScript({
  content: `if (location.hostname === "www.reddit.com") {
  const store = new Map([["rs-port", ${PORT}]]);
  window.GM_getValue = (key, fallback) => (store.has(key) ? store.get(key) : fallback);
  window.GM_setValue = (key, value) => store.set(key, value);
  window.GM_xmlhttpRequest = (o) => {
    window.__rsRequest({ method: o.method, url: o.url, body: o.data })
      .then((r) => o.onload?.({ status: r.status, responseText: r.text }))
      .catch(() => o.onerror?.());
  };
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = "#rs-hud .rs-help { display: none !important; }";
    document.head.append(style);
    (function () {
${await bundle()}
    })();
  });
}`,
});
await page.route("http://demo.test/", (route) =>
  route.fulfill({ contentType: "text/html", body: STAGE }),
);
await page.route("https://www.reddit.com/**", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: redditHtml(new URL(route.request().url()).pathname),
  }),
);

const feed = () =>
  page.frames().find((f) => f.url().startsWith("https://www.reddit.com"));
const online = async () => {
  for (;;) {
    const frame = feed();
    if (frame && (await frame.$("#rs-hud .rs-online").catch(() => null))) {
      return;
    }
    await sleep(25);
  }
};
const navigated = async (pattern) => {
  for (;;) {
    const frame = feed();
    if (frame && pattern.test(new URL(frame.url()).pathname)) break;
    await sleep(25);
  }
  await online();
};
const press = async (cap, what, command, times = 1, gap = 120) => {
  await online();
  await page.evaluate(([c, w]) => window.__key(c, w), [cap, what]);
  for (let i = 0; i < times; i++) {
    daemon.send(command);
    await sleep(gap);
  }
};

await page.goto("http://demo.test/");
const visibleFrom = at();
await online();
await sleep(Math.max(0, 1100 - (at() - visibleFrom) * 1000));
await page.evaluate(() => window.__card(null));
await sleep(500);

await press("Num 0", "start scrolling", "toggle");
await sleep(2400);
await press("Num +", "faster (hold)", "faster", 5, 160);
await sleep(2200);
await press("Num 2", "next post", "next");
await sleep(900);
await press("Num 2", "next post", "next");
await sleep(1200);
await press("Num Enter", "open post", "open");
await navigated(/comments/);
await sleep(900);
await press("Num 0", "scroll the thread", "toggle");
await sleep(2600);
await press("Num .", "back to the feed", "back");
await navigated(/^\/$/);
await sleep(700);
await press("Num 0", "start scrolling again", "toggle");
await sleep(2400);

// The video ends on a single frame of the end card, the one left on screen
// once it stops. Cut before the card fades in; frame timing lags `at()` a bit.
const cutAt = at() - 0.4;
await page.evaluate((html) => window.__card(html), END_CARD);
await sleep(600);
const card = path.join(OUT, "card.png");
await page.screenshot({ path: card });

const video = page.video();
await context.close();
await browser.close();
await daemon.stop();

const raw = await video.path();
const start = (visibleFrom + 0.1).toFixed(2);
const mp4 = path.join(OUT, "demo.mp4");
// CRF 25 veryslow: about 1.5 MB, indistinguishable from CRF 22 on the text.
execFileSync(ffmpeg(), [
  "-loglevel",
  "error",
  "-y",
  "-ss",
  start,
  "-i",
  raw,
  "-framerate",
  "30",
  "-i",
  card,
  "-filter_complex",
  `[0:v]fps=30,trim=0:${(cutAt - start).toFixed(2)},setpts=PTS-STARTPTS,format=yuv420p[a];` +
    "[1:v]format=yuv420p,trim=end_frame=1,setpts=PTS-STARTPTS[b];" +
    "[a][b]concat=n=2:v=1[v]",
  "-map",
  "[v]",
  "-an",
  "-c:v",
  "libx264",
  "-preset",
  "veryslow",
  "-crf",
  "25",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  mp4,
]);
rmSync(raw);
rmSync(card);
console.log(`wrote ${mp4}`);
