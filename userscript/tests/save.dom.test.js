// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { savePost } from "../src/save.js";

/**
 * A post whose overflow menu matches Reddit's live markup: the Save item sits
 * in the menu's open shadow root, rendered even while the menu is closed.
 */
function postWithSave(label) {
  const post = document.createElement("shreddit-post");
  const menu = document.createElement("shreddit-post-overflow-menu");
  menu.attachShadow({ mode: "open" }).innerHTML = `
    <li id="post-overflow-save" role="presentation">
      <div role="menuitem"><span><span class="text-body-2">${label}</span></span></div>
    </li>`;
  post.append(menu);
  document.body.append(post);
  let count = 0;
  menu.shadowRoot
    .querySelector('[role="menuitem"]')
    .addEventListener("click", () => {
      count++;
    });
  return { post, clicks: () => count };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("savePost", () => {
  it("clicks Save and reports saved", () => {
    const { post, clicks } = postWithSave("Save");
    expect(savePost(post)).toBe("saved");
    expect(clicks()).toBe(1);
  });

  it("does not click when already saved", () => {
    const { post, clicks } = postWithSave("Remove from saved");
    expect(savePost(post)).toBe("already saved");
    expect(clicks()).toBe(0);
  });

  it("does not click an unknown label", () => {
    const { post, clicks } = postWithSave("Speichern");
    expect(savePost(post)).toBe("can't save");
    expect(clicks()).toBe(0);
  });

  it("cannot save a post without the menu item", () => {
    const post = document.createElement("shreddit-post");
    document.body.append(post);
    expect(savePost(post)).toBe("can't save");
  });

  it("cannot save without a post", () => {
    expect(savePost(null)).toBe("can't save");
  });

  it("a second press right after saving does not click again", () => {
    const { post, clicks } = postWithSave("Save");
    expect(savePost(post, 0)).toBe("saved");
    expect(savePost(post, 2000)).toBe("already saved");
    expect(clicks()).toBe(1);
  });

  it("the guard expires", () => {
    const { post, clicks } = postWithSave("Save");
    expect(savePost(post, 0)).toBe("saved");
    expect(savePost(post, 10_000)).toBe("saved");
    expect(clicks()).toBe(2);
  });
});
