/**
 * check-version-bump.mjs: the CI step that refuses a pull request which
 * changes the userscript's code without raising its version.
 *
 * Installs update from the bundle on main, and a manager installs an update
 * only when @version rises -- so a missed bump means the change reaches
 * nobody, and nothing says so.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

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
  "  const base = `http://127.0.0.1:${port}`;",
  "  function pageDown() {",
  "    window.scrollBy(0, 1);",
  "  }",
  "})();",
  "",
].join("\n");

const CHANGED = CODE.replace("scrollBy(0, 1)", "scrollBy(0, 2)");

describe("checkVersionBump", () => {
  it("passes a change that leaves the code alone", async () => {
    const result = await checkVersionBump(
      userscript("0.1.0", CODE),
      userscript("0.1.0", CODE),
    );
    expect(result.ok).toBe(true);
  });

  it("ignores the header, so metadata can change without a bump", async () => {
    const head = userscript("0.1.0", CODE, "// @connect      127.0.0.1");
    expect((await checkVersionBump(userscript("0.1.0", CODE), head)).ok).toBe(
      true,
    );
  });

  it("ignores comments and whitespace, so a comment fix is not an update", async () => {
    const reworded = CODE.replace(
      "// src/transport.js",
      "// the transport, reworded",
    ).replace(
      "  function pageDown() {",
      "\n\n  /** Page down. */\n  function pageDown() {",
    );
    expect(
      (
        await checkVersionBump(
          userscript("0.1.0", CODE),
          userscript("0.1.0", reworded),
        )
      ).ok,
    ).toBe(true);
  });

  it("rejects a code change that keeps the version, and says what to do", async () => {
    const result = await checkVersionBump(
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
    expect(
      (
        await checkVersionBump(
          userscript("0.1.0", CODE),
          userscript("0.1.0", changed),
        )
      ).ok,
    ).toBe(false);
  });

  it("accepts a code change with any higher version, a patch bump included", async () => {
    expect(
      (
        await checkVersionBump(
          userscript("0.1.0", CODE),
          userscript("0.1.1", CHANGED),
        )
      ).ok,
    ).toBe(true);
  });

  it("rejects a code change that lowers the version", async () => {
    expect(
      (
        await checkVersionBump(
          userscript("0.2.0", CODE),
          userscript("0.1.9", CHANGED),
        )
      ).ok,
    ).toBe(false);
  });
});

describe("compareVersions", () => {
  it("compares by number, not as text", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.9", "0.1.10")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });
});

describe("the command CI runs", () => {
  const run = promisify(execFile);
  const dir = mkdtempSync(join(tmpdir(), "version-bump-"));
  const file = (name, content) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  it("exits 0 and names both versions when the version rose with the code", async () => {
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
});
