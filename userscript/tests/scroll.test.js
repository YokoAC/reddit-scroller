import { describe, expect, it } from "vitest";
import { ScrollEngine, clampSpeed } from "../src/scroll.js";

function makeEngine(overrides = {}) {
  const moves = [];
  const frames = [];
  const engine = new ScrollEngine({
    scrollBy: (dy) => moves.push(dy),
    requestFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancelFrame: () => {},
    speed: 100,
    min: 15,
    max: 600,
    step: 15,
    ...overrides,
  });
  return { engine, moves, frames };
}

describe("clampSpeed", () => {
  it("passes values inside the range through", () => {
    expect(clampSpeed(90, 15, 600)).toBe(90);
  });

  it("clamps below the minimum", () => {
    expect(clampSpeed(1, 15, 600)).toBe(15);
  });

  it("clamps above the maximum", () => {
    expect(clampSpeed(9000, 15, 600)).toBe(600);
  });
});

describe("ScrollEngine", () => {
  it("starts stopped", () => {
    const { engine, moves } = makeEngine();
    expect(engine.running).toBe(false);
    expect(moves).toEqual([]);
  });

  it("does not scroll on the first frame, which has no delta", () => {
    const { engine, moves } = makeEngine();
    engine.start();
    engine.tick(1000);
    expect(moves).toEqual([]);
  });

  it("scrolls speed multiplied by the frame delta", () => {
    const { engine, moves } = makeEngine({ speed: 100 });
    engine.start();
    engine.tick(1000);
    engine.tick(1050); // 0.05s at 100 px/s — under the MAX_FRAME_SECONDS cap
    expect(moves).toEqual([5]);
  });

  it("accumulates sub-pixel remainders instead of dropping them", () => {
    // 32 px/s at 1/64 s per frame is exactly 0.5 px per frame. Both operands
    // are binary-exact, so this asserts the accumulator's behaviour without
    // floating-point drift deciding the outcome: whole pixels come out every
    // second frame and nothing is lost to truncation.
    const { engine, moves } = makeEngine({ speed: 32 });
    engine.start();
    engine.tick(0);
    for (let i = 1; i <= 4; i += 1) engine.tick(i * 15.625);
    expect(moves).toEqual([1, 1]);
    expect(moves.every(Number.isInteger)).toBe(true);
  });

  it("clamps a huge delta so a backgrounded tab does not lurch", () => {
    const { engine, moves } = makeEngine({ speed: 100 });
    engine.start();
    engine.tick(0);
    engine.tick(60000); // one minute later
    expect(moves).toEqual([10]); // 0.1s cap at 100 px/s
  });

  it("stops scrolling and requesting frames when stopped", () => {
    const { engine, moves, frames } = makeEngine();
    engine.start();
    engine.tick(0);
    engine.stop();
    const framesRequested = frames.length;
    engine.tick(1000);
    expect(engine.running).toBe(false);
    expect(moves).toEqual([]);
    expect(frames.length).toBe(framesRequested);
  });

  it("toggles between running and stopped", () => {
    const { engine } = makeEngine();
    expect(engine.toggle()).toBe(true);
    expect(engine.running).toBe(true);
    expect(engine.toggle()).toBe(false);
    expect(engine.running).toBe(false);
  });

  it("starting twice does not stack two frame loops", () => {
    const { engine, frames } = makeEngine();
    engine.start();
    const after = frames.length;
    engine.start();
    expect(frames.length).toBe(after);
  });

  it("clamps the speed it is given", () => {
    const { engine } = makeEngine();
    engine.setSpeed(9999);
    expect(engine.speed).toBe(600);
    engine.setSpeed(0);
    expect(engine.speed).toBe(15);
  });

  it("adjusts speed by a delta, clamped", () => {
    const { engine } = makeEngine({ speed: 100 });
    engine.adjustSpeed(15);
    expect(engine.speed).toBe(115);
    engine.adjustSpeed(-1000);
    expect(engine.speed).toBe(15);
  });

  it("adopts new limits and re-clamps the current speed", () => {
    const { engine } = makeEngine({ speed: 100 });
    engine.setLimits(200, 1000);
    expect(engine.speed).toBe(200);
    engine.setSpeed(900);
    expect(engine.speed).toBe(900);
  });

  it("resets the accumulator on a speed change so it does not jump", () => {
    const { engine, moves } = makeEngine({ speed: 15 });
    engine.start();
    engine.tick(0);
    engine.tick(30); // accumulates ~0.45px, scrolls nothing
    expect(moves).toEqual([]);
    engine.setSpeed(600);
    engine.tick(60); // 0.03s at 600 px/s = 18px, with no carried remainder
    expect(moves).toEqual([18]);
  });
});
