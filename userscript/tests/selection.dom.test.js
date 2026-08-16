// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { HIGHLIGHT_CLASS, readPosts, Selection } from "../src/selection.js";

const POSTS = [
  { permalink: "/r/a/comments/1/one/", title: "One", sub: "r/a", score: "12" },
  { permalink: "/r/b/comments/2/two/", title: "Two", sub: "r/b", score: "34" },
  {
    permalink: "/r/c/comments/3/three/",
    title: "Three",
    sub: "r/c",
    score: "56",
  },
];

function buildFeed(posts = POSTS) {
  document.body.innerHTML = posts
    .map(
      (p) =>
        `<shreddit-post permalink="${p.permalink}" post-title="${p.title}" ` +
        `subreddit-prefixed-name="${p.sub}" score="${p.score}"></shreddit-post>`,
    )
    .join("");
  // jsdom has no layout, so stub the rects: 200px tall, stacked from y=0.
  document.querySelectorAll("shreddit-post").forEach((el, i) => {
    el.getBoundingClientRect = () => ({
      top: i * 200,
      bottom: i * 200 + 200,
      left: 0,
      right: 500,
      width: 500,
      height: 200,
    });
    el.scrollIntoView = () => {};
  });
}

function makeSelection() {
  return new Selection({
    root: document,
    getViewportHeight: () => 1000,
    focusLine: 0.25,
  });
}

beforeEach(() => buildFeed());

describe("readPosts", () => {
  it("reads every post's attributes", () => {
    const found = readPosts(document);
    expect(found).toHaveLength(3);
    expect(found[1]).toMatchObject({
      permalink: "/r/b/comments/2/two/",
      title: "Two",
      subreddit: "r/b",
      score: 34,
    });
  });

  it("returns an empty list when the feed has no posts", () => {
    document.body.innerHTML = "<div>nothing here</div>";
    expect(readPosts(document)).toEqual([]);
  });

  it("skips posts with no permalink, which cannot be opened", () => {
    document.body.innerHTML =
      '<shreddit-post post-title="Broken"></shreddit-post>';
    expect(readPosts(document)).toEqual([]);
  });

  it("treats a missing score as zero", () => {
    document.body.innerHTML =
      '<shreddit-post permalink="/r/a/comments/1/x/" post-title="X"></shreddit-post>';
    expect(readPosts(document)[0].score).toBe(0);
  });
});

describe("Selection", () => {
  it("selects the post nearest the focus line", () => {
    const sel = makeSelection();
    sel.refresh();
    // Focus line is 250; tops are 0, 200, 400 — 200 is nearest.
    expect(sel.selected.title).toBe("Two");
    expect(sel.count).toBe(3);
  });

  it("reports null when there are no posts", () => {
    document.body.innerHTML = "";
    const sel = makeSelection();
    sel.refresh();
    expect(sel.selected).toBeNull();
    expect(sel.selectedElement).toBeNull();
    expect(sel.count).toBe(0);
  });

  it("moves selection forward and backward", () => {
    const sel = makeSelection();
    sel.refresh();
    sel.move(1);
    expect(sel.selected.title).toBe("Three");
    sel.move(-1);
    expect(sel.selected.title).toBe("Two");
  });

  it("clamps movement at both ends", () => {
    const sel = makeSelection();
    sel.refresh();
    sel.move(-5);
    expect(sel.selected.title).toBe("One");
    sel.move(99);
    expect(sel.selected.title).toBe("Three");
  });

  it("selects the first post on a cold start (nothing intersecting the viewport)", () => {
    const sel = makeSelection();
    // Push every post below the viewport so refresh() lands on index -1 —
    // the state of a just-loaded feed (or a tall ad block) before anything
    // qualifies for the focus line.
    document.querySelectorAll("shreddit-post").forEach((el, i) => {
      el.getBoundingClientRect = () => ({
        top: 1000 + i * 200,
        bottom: 1200 + i * 200,
        left: 0,
        right: 500,
        width: 500,
        height: 200,
      });
    });
    sel.refresh();
    expect(sel.selected).toBeNull(); // confirms the cold-start precondition

    sel.move(1);
    expect(sel.selected.title).toBe("One"); // must not skip straight to "Two"
  });

  it("returns null from move when there are no posts", () => {
    document.body.innerHTML = "";
    const sel = makeSelection();
    sel.refresh();
    expect(sel.move(1)).toBeNull();
  });

  it("highlights exactly one post", () => {
    const sel = makeSelection();
    sel.refresh();
    sel.applyHighlight();
    const marked = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
    expect(marked).toHaveLength(1);
    expect(marked[0].getAttribute("post-title")).toBe("Two");
  });

  it("moves the highlight rather than adding a second one", () => {
    const sel = makeSelection();
    sel.refresh();
    sel.applyHighlight();
    sel.move(1);
    sel.applyHighlight();
    const marked = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
    expect(marked).toHaveLength(1);
    expect(marked[0].getAttribute("post-title")).toBe("Three");
  });

  it("selects a different post once the focus line moves", () => {
    const sel = makeSelection();
    sel.refresh();
    expect(sel.selected.title).toBe("Two"); // focus line 250, tops 0/200/400
    sel.setFocusLine(0.45); // focus line 450, so top 400 wins
    sel.refresh();
    expect(sel.selected.title).toBe("Three");
  });

  it("keeps the manually chosen post selected across a refresh", () => {
    const sel = makeSelection();
    sel.refresh();
    sel.move(1); // "Three", away from the focus line
    sel.refresh();
    expect(sel.selected.title).toBe("Three");
  });

  it("follows the focus line again once the pinned post scrolls away", () => {
    const sel = makeSelection();
    sel.refresh();
    sel.move(1); // pin "Three"
    document.querySelectorAll("shreddit-post").forEach((el, i) => {
      el.getBoundingClientRect = () => ({
        top: i * 200 - 3000,
        bottom: i * 200 - 2800,
        left: 0,
        right: 500,
        width: 500,
        height: 200,
      });
    });
    sel.refresh();
    expect(sel.selected).toBeNull();
  });
});
