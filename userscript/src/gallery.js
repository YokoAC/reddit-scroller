/** Stepping through a gallery post's images with Reddit's own buttons. */

const BUTTONS = {
  prev: '[slot="prevButton"] button',
  next: '[slot="nextButton"] button',
};

/** The first match under `root`, looking inside open shadow roots too. */
function deepQuery(root, selector) {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  for (const host of [root, ...root.querySelectorAll("*")]) {
    if (host.shadowRoot) {
      const found = deepQuery(host.shadowRoot, selector);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Click the previous or next button of the gallery in `post`. Returns whether
 * it clicked: false with no post, no gallery, or at either end, where Reddit
 * marks the button aria-disabled.
 */
export function stepGallery(post, direction) {
  if (!post) return false;
  const button = deepQuery(post, BUTTONS[direction]);
  if (!button || button.getAttribute("aria-disabled") === "true") return false;
  button.click();
  return true;
}
