/**
 * The userscript's metadata block, held to Greasy Fork's rules and to the rest
 * of the repository.
 *
 * The header is the part of the bundle a person reads before installing, the
 * part Greasy Fork parses, and the part a manager consults to decide whether a
 * script is already installed and whether a newer one exists. Each line is a
 * promise; this makes them checkable.
 *
 *   rules: https://greasyfork.org/en/help/code-rules
 *   keys:  https://greasyfork.org/en/help/meta-keys
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = "https://github.com/YokoAC/reddit-scroller";
const INSTALL_URL =
  "https://raw.githubusercontent.com/YokoAC/reddit-scroller/main/userscript/dist/reddit-scroller.user.js";

function read(path) {
  return readFileSync(
    fileURLToPath(new URL(path, import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
}

const BUNDLE = read("../dist/reddit-scroller.user.js");
const PACKAGE = JSON.parse(read("../package.json"));

const HEADER = BUNDLE.match(
  /^\/\/ ==UserScript==\n([\s\S]*?)\n\/\/ ==\/UserScript==\n/,
);
const BODY = HEADER ? BUNDLE.slice(HEADER[0].length) : "";

/** Every `// @key value` line in the block, in order, as [key, value]. */
const META = HEADER
  ? [...HEADER[1].matchAll(/^\/\/ @(\S+)[ \t]*(.*?)[ \t]*$/gm)].map((m) => [
      m[1],
      m[2],
    ])
  : [];

const values = (key) => META.filter(([k]) => k === key).map(([, v]) => v);

function only(key) {
  const found = values(key);
  expect(found, `@${key} should appear exactly once`).toHaveLength(1);
  return found[0];
}

describe("the metadata block", () => {
  it("opens the file", () => {
    expect(HEADER).not.toBeNull();
  });

  it("carries every key Greasy Fork requires", () => {
    for (const key of ["name", "namespace", "version", "description"]) {
      expect(only(key), `@${key}`).not.toBe("");
    }
    expect(values("match").length + values("include").length).toBeGreaterThan(
      0,
    );
  });

  it("declares the licence the repository is under, as an SPDX identifier", () => {
    expect(only("license")).toBe("MIT");
    expect(read("../../LICENSE").split("\n")[0]).toBe("MIT License");
  });

  it("names the author the licence names", () => {
    const holder = read("../../LICENSE").match(
      /^Copyright \(c\) \d{4} (.+)$/m,
    )[1];
    expect(only("author")).toBe(holder);
  });

  it("says which browsers it is tested in, and no others", () => {
    // Only what the browser suite actually runs. Greasy Fork shows these on
    // the listing, so an untested claim would be a promise nobody checks.
    const browsers = values("compatible")
      .map((v) => v.split(/\s+/)[0])
      .sort();
    expect(browsers).toEqual(["chrome", "firefox"]);
  });

  it("runs only on the site it works on", () => {
    // Greasy Fork allows no @match for a site the script does nothing on. Old
    // Reddit has no shreddit-post elements, so it is deliberately absent.
    expect(values("match")).toEqual(["https://www.reddit.com/*"]);
    expect(values("include")).toEqual([]);
  });
});

describe("the code under the header", () => {
  it("loads nothing from anywhere else", () => {
    // Greasy Fork: "the primary functionality of a script must be within the
    // code on Greasy Fork". Nothing is required, so nothing runs unread.
    expect(values("require")).toEqual([]);
    expect(values("resource")).toEqual([]);
  });

  it("is readable rather than minified", () => {
    // Greasy Fork: bundled code "must be output in non-minified form, with
    // whitespace and variable names retained". A minify flag in build.mjs
    // would collapse this into a handful of very long lines.
    const lines = BODY.split("\n");
    expect(lines.length).toBeGreaterThan(200);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(200);
  });

  it("asks for exactly the grants it uses", () => {
    const used = [...new Set(BODY.match(/\bGM_\w+/g))].sort();
    expect(values("grant").sort()).toEqual(used);
  });
});

describe("identity and updates", () => {
  it("keeps the namespace that identifies it", () => {
    // Managers identify a script by @name plus @namespace, and Greasy Fork
    // warns when either changes. Moving one turns every existing install into
    // a second copy -- and two copies of this script act on every command.
    expect(only("name")).toBe("Reddit Scroller");
    expect(only("namespace")).toBe(REPO);
  });

  it("updates from the file it was installed from", () => {
    // Greasy Fork strips both keys, so an install from there updates only
    // from there. These serve the GitHub install the README documents.
    expect(only("updateURL")).toBe(INSTALL_URL);
    expect(only("downloadURL")).toBe(INSTALL_URL);
  });

  it("points at the repository and its issue tracker", () => {
    expect(only("homepageURL")).toBe(REPO);
    expect(only("supportURL")).toBe(`${REPO}/issues`);
  });
});

describe("the version", () => {
  it("comes from package.json, in the format Greasy Fork expects", () => {
    expect(only("version")).toBe(PACKAGE.version);
    expect(PACKAGE.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is the daemon's version too, since both halves ship together", () => {
    const pyproject = read("../../pyproject.toml").match(
      /^version = "(.+)"$/m,
    )[1];
    const module = read("../../src/reddit_scroller/__init__.py").match(
      /^__version__ = "(.+)"$/m,
    )[1];
    expect(pyproject).toBe(PACKAGE.version);
    expect(module).toBe(PACKAGE.version);
  });
});

describe("permissions", () => {
  it("may reach the loopback address and nothing else", () => {
    // The daemon's 127.0.0.1 bind is the whole security boundary. A script
    // allowed to connect anywhere else would widen it from the other side.
    // localhost was listed from the start, and nothing ever used it.
    expect(values("connect")).toEqual(["127.0.0.1"]);
  });
});
