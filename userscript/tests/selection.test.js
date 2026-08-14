import { describe, expect, it } from "vitest";
import { rankPosts } from "../src/selection.js";

const VIEWPORT = 1000;
const FOCUS_Y = 250;

describe("rankPosts", () => {
  it("returns -1 for an empty list", () => {
    expect(rankPosts([], FOCUS_Y, VIEWPORT)).toBe(-1);
  });

  it("picks the post whose top edge is nearest the focus line", () => {
    const rects = [
      { top: 10, bottom: 200 },
      { top: 210, bottom: 400 },
      { top: 600, bottom: 900 },
    ];
    expect(rankPosts(rects, FOCUS_Y, VIEWPORT)).toBe(1);
  });

  it("can pick a post whose top edge is above the focus line", () => {
    const rects = [
      { top: 240, bottom: 700 },
      { top: 720, bottom: 900 },
    ];
    expect(rankPosts(rects, FOCUS_Y, VIEWPORT)).toBe(0);
  });

  it("considers a post scrolled partly off the top if it still intersects", () => {
    const rects = [
      { top: -100, bottom: 300 },
      { top: 800, bottom: 1200 },
    ];
    expect(rankPosts(rects, FOCUS_Y, VIEWPORT)).toBe(0);
  });

  it("ignores posts entirely above the viewport", () => {
    const rects = [
      { top: -900, bottom: -400 },
      { top: 600, bottom: 800 },
    ];
    expect(rankPosts(rects, FOCUS_Y, VIEWPORT)).toBe(1);
  });

  it("ignores posts entirely below the viewport", () => {
    const rects = [
      { top: 400, bottom: 700 },
      { top: 1200, bottom: 1600 },
    ];
    expect(rankPosts(rects, FOCUS_Y, VIEWPORT)).toBe(0);
  });

  it("returns -1 when nothing intersects the viewport", () => {
    const rects = [
      { top: -900, bottom: -400 },
      { top: 1200, bottom: 1600 },
    ];
    expect(rankPosts(rects, FOCUS_Y, VIEWPORT)).toBe(-1);
  });

  it("breaks ties toward the earlier post", () => {
    const rects = [
      { top: 200, bottom: 400 },
      { top: 300, bottom: 500 },
    ];
    expect(rankPosts(rects, FOCUS_Y, VIEWPORT)).toBe(0);
  });
});
