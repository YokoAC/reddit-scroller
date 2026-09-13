/**
 * Refuses a change to the userscript that does not raise its version.
 *
 * Installs update from the bundle on main, and a userscript manager installs
 * an update only when @version rises -- so a change merged under the old
 * version reaches nobody, and nothing says so. CI runs this against the
 * previous commit's bundle:
 *
 *   node check-version-bump.mjs <base.user.js> <head.user.js>
 *
 * Every header line but @version counts, since a manager applies a new
 * @connect or @grant only when it updates. In the code, comments and
 * whitespace do not: both bodies go through esbuild's parser, which, unlike a
 * regex, knows that the // in "http://127.0.0.1" belongs to a string.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { transform } from "esbuild";

const HEADER_END = "// ==/UserScript==";
const VERSION_LINE = /^\/\/ @version[ \t]+(\S+)[ \t]*$/m;

/** A userscript's @version, its other header lines, and its code. */
export function splitUserscript(source) {
  const text = source.replace(/\r\n/g, "\n");
  const end = text.indexOf(HEADER_END);
  if (end === -1) throw new Error("no ==UserScript== header");
  const header = text.slice(0, end);
  const version = header.match(VERSION_LINE)?.[1];
  if (!version) throw new Error("no @version in the header");
  return {
    version,
    header: header
      .split("\n")
      .filter((line) => !/^\/\/ @version\b/.test(line))
      .map((line) => line.trimEnd())
      .join("\n"),
    code: text.slice(end + HEADER_END.length),
  };
}

/** Negative, zero or positive, comparing x.y.z versions number by number. */
export function compareVersions(a, b) {
  const parse = (version) => {
    if (!/^\d+(\.\d+)*$/.test(version)) {
      throw new Error(`not a numeric version: "${version}"`);
    }
    return version.split(".").map(Number);
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function normalise(code) {
  return (await transform(code, { minifyWhitespace: true, loader: "js" })).code;
}

/** Whether `headSource` may replace `baseSource`: unchanged, or a higher version. */
export async function checkVersionBump(baseSource, headSource) {
  const base = splitUserscript(baseSource);
  const head = splitUserscript(headSource);
  const changed = [];
  if (base.header !== head.header) changed.push("header");
  if ((await normalise(base.code)) !== (await normalise(head.code))) {
    changed.push("code");
  }
  if (changed.length === 0) {
    return { ok: true, message: `Unchanged; ${head.version} needs no bump.` };
  }
  const what = changed.join(" and ");
  if (compareVersions(head.version, base.version) > 0) {
    return {
      ok: true,
      message: `The ${what} changed and the version rose from ${base.version} to ${head.version}.`,
    };
  }
  return {
    ok: false,
    message:
      `The userscript's ${what} changed but its version did not rise ` +
      `(${base.version} to ${head.version}), so no installed copy would update. ` +
      `Raise "version" in userscript/package.json and run npm run build.`,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [basePath, headPath] = process.argv.slice(2);
  const result = await checkVersionBump(
    readFileSync(basePath, "utf8"),
    readFileSync(headPath, "utf8"),
  );
  if (result.ok) {
    console.log(result.message);
  } else {
    console.log(`::error::${result.message}`);
    process.exit(1);
  }
}
