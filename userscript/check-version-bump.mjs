/**
 * Refuses a change to the userscript's code that does not raise its version.
 *
 * Installs update from the bundle on main, and a userscript manager installs
 * an update only when @version rises -- so a code change merged under the old
 * version reaches nobody, and nothing says so. CI runs this on every pull
 * request, against the base branch's bundle:
 *
 *   node check-version-bump.mjs <base.user.js> <head.user.js>
 *
 * The header is ignored, and so are comments and whitespace: both bodies go
 * through esbuild's own parser, which, unlike a regex, knows that the // in
 * "http://127.0.0.1" belongs to a string.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { transform } from "esbuild";

const HEADER_END = "// ==/UserScript==";

/** A userscript's @version, and the code below its header. */
export function splitUserscript(source) {
  const end = source.indexOf(HEADER_END);
  if (end === -1) throw new Error("no ==UserScript== header");
  const version = source.slice(0, end).match(/^\/\/ @version\s+(\S+)/m)?.[1];
  if (!version) throw new Error("no @version in the header");
  return { version, code: source.slice(end + HEADER_END.length) };
}

/** Negative, zero or positive, comparing x.y.z versions number by number. */
export function compareVersions(a, b) {
  const parse = (version) =>
    version.split(".").map((part) => {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`not a numeric version: ${version}`);
      }
      return n;
    });
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

/** Whether `headSource` may replace `baseSource`: same code, or a higher version. */
export async function checkVersionBump(baseSource, headSource) {
  const base = splitUserscript(baseSource);
  const head = splitUserscript(headSource);
  if ((await normalise(base.code)) === (await normalise(head.code))) {
    return {
      ok: true,
      message: `Code unchanged; ${head.version} needs no bump.`,
    };
  }
  if (compareVersions(head.version, base.version) > 0) {
    return {
      ok: true,
      message: `Code changed and the version rose from ${base.version} to ${head.version}.`,
    };
  }
  return {
    ok: false,
    message:
      `The userscript's code changed but its version did not rise ` +
      `(base ${base.version}, head ${head.version}), so no installed copy would update. ` +
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
