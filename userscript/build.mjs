import { readFileSync } from "node:fs";

import { build } from "esbuild";

import { BUILD_TARGET } from "./build-target.js";

// The version is written once, in package.json, and copied into the header. A
// manager installs an update only when @version rises, so it must never be a
// second number that someone forgets to bump.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

const REPO = "https://github.com/YokoAC/reddit-scroller";
const INSTALL_URL =
  "https://raw.githubusercontent.com/YokoAC/reddit-scroller/main/userscript/dist/reddit-scroller.user.js";

// Held to Greasy Fork's rules by tests/header.test.js. @namespace is this
// script's identity to every manager that has it installed: never change it.
const BANNER = `// ==UserScript==
// @name         Reddit Scroller
// @namespace    ${REPO}
// @version      ${version}
// @description  Auto-scrolls Reddit feeds and threads, driven by the numpad, with an on-screen HUD. An optional Windows companion keeps the keys working while another application, such as a full-screen game, has focus.
// @author       YokoAC
// @license      MIT
// @homepageURL  ${REPO}
// @supportURL   ${REPO}/issues
// @updateURL    ${INSTALL_URL}
// @downloadURL  ${INSTALL_URL}
// @match        https://www.reddit.com/*
// @compatible   firefox
// @compatible   chrome
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @run-at       document-idle
// @noframes
// ==/UserScript==`;

await build({
  entryPoints: ["src/main.js"],
  outfile: "dist/reddit-scroller.user.js",
  bundle: true,
  format: "iife",
  target: BUILD_TARGET,
  banner: { js: BANNER },
  legalComments: "none",
});

console.log(`built dist/reddit-scroller.user.js (v${version})`);
