/** Saving a post with Reddit's own Save item, without opening its menu. */

import { deepQuery } from "./gallery.js";

const ITEM = '#post-overflow-save [role="menuitem"]';

// Reddit relabels the item only once its request returns, so a quick second
// press would still read "Save" and unsave the post.
const RESAVE_GUARD_MS = 5000;
const lastSaved = new WeakMap();

/**
 * Save `post` to the account's Saved list. Only ever saves: the item toggles,
 * so it is clicked only while its label reads "Save".
 */
export function savePost(post, now = Date.now()) {
  if (!post) return "can't save";
  const item = deepQuery(post, ITEM);
  if (!item) return "can't save";
  const label = item.textContent.trim();
  if (label === "Remove from saved") return "already saved";
  if (label !== "Save") return "can't save";
  if (now - (lastSaved.get(post) ?? -Infinity) < RESAVE_GUARD_MS) {
    return "already saved";
  }
  item.click();
  lastSaved.set(post, now);
  return "saved";
}
