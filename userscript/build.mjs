import { build } from "esbuild";

const BANNER = `// ==UserScript==
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
// ==/UserScript==`;

await build({
  entryPoints: ["src/main.js"],
  outfile: "dist/reddit-scroller.user.js",
  bundle: true,
  format: "iife",
  target: "firefox115",
  banner: { js: BANNER },
  legalComments: "none",
});

console.log("built dist/reddit-scroller.user.js");
