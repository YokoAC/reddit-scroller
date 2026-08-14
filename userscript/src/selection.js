/** Reading Reddit's feed posts and tracking which one is "current". */

export const HIGHLIGHT_CLASS = "rs-selected";
const POST_SELECTOR = "shreddit-post";

/**
 * Index of the post whose top edge sits nearest the focus line, among those
 * intersecting the viewport. Returns -1 when nothing qualifies.
 */
export function rankPosts(rects, focusY, viewportHeight) {
  let best = -1;
  let bestDistance = Infinity;
  rects.forEach((rect, index) => {
    if (rect.bottom <= 0 || rect.top >= viewportHeight) return;
    const distance = Math.abs(rect.top - focusY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Read every usable post out of the feed. */
export function readPosts(root) {
  return Array.from(root.querySelectorAll(POST_SELECTOR))
    .filter((element) => element.getAttribute("permalink"))
    .map((element) => ({
      element,
      permalink: element.getAttribute("permalink"),
      title: element.getAttribute("post-title") || "",
      subreddit: element.getAttribute("subreddit-prefixed-name") || "",
      score: Number(element.getAttribute("score") || 0),
    }));
}

export class Selection {
  constructor({ root, getViewportHeight, focusLine }) {
    this._root = root;
    this._getViewportHeight = getViewportHeight;
    this._focusLine = focusLine;
    this._posts = [];
    this._index = -1;
    // A permalink the user chose explicitly with prev/next. While it is still
    // on screen it wins over the focus line, so a deliberate choice is not
    // yanked away by the next scroll frame.
    this._pinned = null;
  }

  get count() {
    return this._posts.length;
  }

  get focusLine() {
    return this._focusLine;
  }

  setFocusLine(fraction) {
    this._focusLine = fraction;
  }

  get selectedElement() {
    const post = this._posts[this._index];
    return post ? post.element : null;
  }

  get selected() {
    const post = this._posts[this._index];
    if (!post) return null;
    const { permalink, title, subreddit, score } = post;
    return { permalink, title, subreddit, score };
  }

  refresh() {
    this._posts = readPosts(this._root);
    if (this._posts.length === 0) {
      this._index = -1;
      return;
    }

    const viewportHeight = this._getViewportHeight();
    const rects = this._posts.map((post) =>
      post.element.getBoundingClientRect(),
    );

    if (this._pinned !== null) {
      const pinnedIndex = this._posts.findIndex(
        (post) => post.permalink === this._pinned,
      );
      const rect = rects[pinnedIndex];
      const stillVisible =
        rect && rect.bottom > 0 && rect.top < viewportHeight;
      if (stillVisible) {
        this._index = pinnedIndex;
        return;
      }
      this._pinned = null;
    }

    this._index = rankPosts(
      rects,
      viewportHeight * this._focusLine,
      viewportHeight,
    );
  }

  move(delta) {
    if (this._posts.length === 0) return null;
    const from =
      this._index === -1 ? (delta > 0 ? -1 : 0) : this._index;
    this._index = Math.min(
      this._posts.length - 1,
      Math.max(0, from + delta),
    );
    this._pinned = this._posts[this._index].permalink;
    return this.selectedElement;
  }

  applyHighlight() {
    const wanted = this.selectedElement;
    this._root
      .querySelectorAll(`.${HIGHLIGHT_CLASS}`)
      .forEach((element) => {
        if (element !== wanted) element.classList.remove(HIGHLIGHT_CLASS);
      });
    if (wanted) wanted.classList.add(HIGHLIGHT_CLASS);
  }
}
