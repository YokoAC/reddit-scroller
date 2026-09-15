// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { stepGallery } from "../src/gallery.js";

/**
 * A post whose carousel matches Reddit's current markup: the buttons are
 * light-DOM children slotted into the carousel's open shadow root.
 */
function galleryPost({ nextDisabled = false, prevDisabled = false } = {}) {
  const post = document.createElement("shreddit-post");
  const carousel = document.createElement("gallery-carousel");
  carousel.attachShadow({ mode: "open" }).innerHTML =
    '<slot name="prevButton"></slot><slot></slot><slot name="nextButton"></slot>';
  carousel.innerHTML = `
    <span slot="prevButton"><button aria-label="Previous page" aria-disabled="${prevDisabled}"></button></span>
    <span slot="nextButton"><button aria-label="Next page" aria-disabled="${nextDisabled}"></button></span>`;
  post.append(carousel);
  document.body.append(post);
  return post;
}

function clicks(post, slot) {
  const button = post.querySelector(`[slot="${slot}"] button`);
  let count = 0;
  button.addEventListener("click", () => {
    count++;
  });
  return () => count;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("stepGallery", () => {
  it("clicks the next button", () => {
    const post = galleryPost();
    const next = clicks(post, "nextButton");
    const prev = clicks(post, "prevButton");
    expect(stepGallery(post, "next")).toBe(true);
    expect([next(), prev()]).toEqual([1, 0]);
  });

  it("clicks the previous button", () => {
    const post = galleryPost();
    const next = clicks(post, "nextButton");
    const prev = clicks(post, "prevButton");
    expect(stepGallery(post, "prev")).toBe(true);
    expect([next(), prev()]).toEqual([0, 1]);
  });

  it("does nothing at the last image", () => {
    const post = galleryPost({ nextDisabled: true });
    const next = clicks(post, "nextButton");
    expect(stepGallery(post, "next")).toBe(false);
    expect(next()).toBe(0);
  });

  it("does nothing on a post without a gallery", () => {
    const post = document.createElement("shreddit-post");
    document.body.append(post);
    expect(stepGallery(post, "next")).toBe(false);
  });

  it("does nothing without a post", () => {
    expect(stepGallery(null, "next")).toBe(false);
  });

  it("finds buttons that Reddit moves inside an open shadow root", () => {
    const post = document.createElement("shreddit-post");
    const carousel = document.createElement("gallery-carousel");
    carousel.attachShadow({ mode: "open" }).innerHTML =
      '<span slot="nextButton"><button aria-label="Next page"></button></span>';
    post.append(carousel);
    document.body.append(post);
    let count = 0;
    carousel.shadowRoot
      .querySelector("button")
      .addEventListener("click", () => {
        count++;
      });
    expect(stepGallery(post, "next")).toBe(true);
    expect(count).toBe(1);
  });

  it("ignores a gallery in a different post", () => {
    const other = galleryPost();
    const otherNext = clicks(other, "nextButton");
    const post = document.createElement("shreddit-post");
    document.body.append(post);
    expect(stepGallery(post, "next")).toBe(false);
    expect(otherNext()).toBe(0);
  });
});
