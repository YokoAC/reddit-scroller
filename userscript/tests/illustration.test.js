/**
 * The README's HUD illustration against the panel it illustrates.
 *
 * docs/hud.svg is hand-drawn, and nothing rendered it, so it drifted: standby
 * shipped with a tenth hotkey row and the picture kept advertising nine. Prose
 * and pictures go stale silently. This is the cheapest thing that stops it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { helpRows } from "../src/hud.js";

const SVG = readFileSync(
  fileURLToPath(new URL("../../docs/hud.svg", import.meta.url)),
  "utf8",
);

/** The SVG stores "Num −" as "Num &#8722;"; helpRows hands back the character. */
function decode(text) {
  return text.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(Number(code)),
  );
}

/** Every <text> body carrying `className`, in document order. */
function textsOfClass(className) {
  const pattern = new RegExp(
    `class="[^"]*\\b${className}\\b[^"]*"[^>]*>([^<]*)<`,
    "g",
  );
  return [...SVG.matchAll(pattern)].map((match) => decode(match[1]));
}

describe("docs/hud.svg", () => {
  const rows = helpRows(undefined);

  it("advertises exactly the keys the panel does, in the same order", () => {
    expect(textsOfClass("hkey")).toEqual(rows.map((row) => row.key));
  });

  it("describes each of them the way the panel describes it", () => {
    expect(textsOfClass("hact")).toEqual(rows.map((row) => row.action));
  });

  it("draws a panel tall enough to hold the rows it contains", () => {
    // Rows are 19px apart from y=214. "Fits" is not enough: a baseline three
    // pixels above the edge clips its own descenders, so require the same
    // 16px breathing room the panel uses everywhere else.
    const PADDING = 16;
    const lastBaseline = 214 + (rows.length - 1) * 19;
    const panel = SVG.match(/<rect[^>]*y="(\d+)"[^>]*height="(\d+)"/);
    expect(panel).not.toBeNull();
    const panelBottom = Number(panel[1]) + Number(panel[2]);
    expect(panelBottom).toBeGreaterThanOrEqual(lastBaseline + PADDING);

    // ...and the canvas has to hold the panel, or the box is cropped instead.
    const canvasHeight = Number(SVG.match(/<svg[^>]*height="(\d+)"/)[1]);
    expect(canvasHeight).toBeGreaterThanOrEqual(panelBottom);
    expect(SVG).toContain(`viewBox="0 0 392 ${canvasHeight}"`);
  });
});
