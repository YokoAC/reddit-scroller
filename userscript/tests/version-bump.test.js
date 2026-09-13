/**
 * check-version-bump.mjs: the CI step that refuses a change to the userscript
 * -- its code or its header -- that does not raise its version.
 *
 * Installs update from the bundle on main, and a manager installs an update
 * only when @version rises -- so a missed bump means the change reaches
 * nobody, and nothing says so.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkVersionBump, compareVersions } from "../check-version-bump.mjs";

const SCRIPT = fileURLToPath(
  new URL("../check-version-bump.mjs", import.meta.url),
);

/** A minimal userscript: a header carrying `version`, then `code`. */
function userscript(version, code, extraHeader = "") {
  return [
    "// ==UserScript==",
    "// @name         Reddit Scroller",
    `// @version      ${version}`,
    ...(extraHeader ? [extraHeader] : []),
    "// ==/UserScript==",
    code,
  ].join("\n");
}

const CODE = [
  "(() => {",
  "  // src/transport.js",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: bundle source text
  "  const base = `http://127.0.0.1:${port}`;",
  "  function pageDown() {",
  "    window.scrollBy(0, 1);",
  "  }",
  "})();",
  "",
].join("\n");

const CHANGED = CODE.replace("scrollBy(0, 1)", "scrollBy(0, 2)");

const check = (base, head) => checkVersionBump(base, head);

describe("checkVersionBump", () => {
  it("passes when nothing changed", async () => {
    const result = await check(
      userscript("0.1.0", CODE),
      userscript("0.1.0", CODE),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a header change that keeps the version", async () => {
    // Managers apply a new @connect, @grant or @match only when they update.
    const head = userscript("0.1.0", CODE, "// @connect      127.0.0.1");
    const result = await check(userscript("0.1.0", CODE), head);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("header");
  });

  it("accepts a header change with a higher version", async () => {
    const head = userscript("0.1.1", CODE, "// @connect      127.0.0.1");
    expect((await check(userscript("0.1.0", CODE), head)).ok).toBe(true);
  });

  it("ignores comments and whitespace in the code", async () => {
    const reworded = CODE.replace(
      "// src/transport.js",
      "// the transport, reworded",
    ).replace(
      "  function pageDown() {",
      "\n\n  /** Page down. */\n  function pageDown() {",
    );
    const result = await check(
      userscript("0.1.0", CODE),
      userscript("0.1.0", reworded),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a code change that keeps the version, and says what to do", async () => {
    const result = await check(
      userscript("0.1.0", CODE),
      userscript("0.1.0", CHANGED),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("userscript/package.json");
  });

  it("sees a change inside a string that contains //", async () => {
    // A regex stripping everything after // would erase this URL and call
    // the two bundles equal.
    const changed = CODE.replace("127.0.0.1", "127.0.0.2");
    const result = await check(
      userscript("0.1.0", CODE),
      userscript("0.1.0", changed),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a code change with any higher version, a patch bump included", async () => {
    const result = await check(
      userscript("0.1.0", CODE),
      userscript("0.1.1", CHANGED),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a code change that lowers the version", async () => {
    const result = await check(
      userscript("0.2.0", CODE),
      userscript("0.1.9", CHANGED),
    );
    expect(result.ok).toBe(false);
  });
});

describe("compareVersions", () => {
  it("compares by number, not as text", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.9", "0.1.10")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("refuses anything but dot-separated digits", () => {
    for (const bad of ["0x10", "1e1", "1..0", "1.0.", "", "1.0.0-beta"]) {
      expect(() => compareVersions(bad, "1.0.0"), bad).toThrow(/version/);
    }
  });
});

describe("malformed input", () => {
  it("refuses a file without a header", async () => {
    await expect(check(CODE, userscript("0.1.0", CODE))).rejects.toThrow(
      /header/,
    );
  });

  it("refuses a header without a version", async () => {
    const head = userscript("0.1.0", CODE).replace(
      "// @version      0.1.0\n",
      "",
    );
    await expect(check(userscript("0.1.0", CODE), head)).rejects.toThrow(
      /@version/,
    );
  });

  it("does not read a version off the next line when @version is empty", async () => {
    // A line follows it, so a pattern crossing the newline would read "//".
    const head = userscript(
      "0.1.0",
      CODE,
      "// @connect      127.0.0.1",
    ).replace("// @version      0.1.0", "// @version");
    await expect(check(userscript("0.1.0", CODE), head)).rejects.toThrow(
      /@version/,
    );
  });
});

describe("the command CI runs", () => {
  const run = promisify(execFile);
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "version-bump-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const file = (name, content) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  it("exits 0 and names both versions when the version rose", async () => {
    const base = file("ok-base.user.js", userscript("0.1.0", CODE));
    const head = file("ok-head.user.js", userscript("0.1.1", CHANGED));
    const { stdout } = await run(process.execPath, [SCRIPT, base, head]);
    expect(stdout).toContain("0.1.0");
    expect(stdout).toContain("0.1.1");
  });

  it("exits 1 with a GitHub error annotation when it did not", async () => {
    const base = file("bad-base.user.js", userscript("0.1.0", CODE));
    const head = file("bad-head.user.js", userscript("0.1.0", CHANGED));
    const failure = await run(process.execPath, [SCRIPT, base, head]).catch(
      (error) => error,
    );
    expect(failure.code).toBe(1);
    expect(failure.stdout).toMatch(/^::error::/m);
  });

  it("fails rather than passes when a file is missing", async () => {
    const base = file("missing-base.user.js", userscript("0.1.0", CODE));
    const failure = await run(process.execPath, [
      SCRIPT,
      base,
      join(dir, "does-not-exist.user.js"),
    ]).catch((error) => error);
    expect(failure.code).not.toBe(0);
  });
});
