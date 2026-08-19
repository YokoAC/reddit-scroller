import { describe, expect, it } from "vitest";
import { clampSpeed, ScrollEngine } from "../src/scroll.js";

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

  it("falls back to the minimum when handed something that is not a number", () => {
    expect(clampSpeed(Number.NaN, 15, 600)).toBe(15);
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

  it("seeds the default speed when nothing has claimed the speed yet", () => {
    const { engine } = makeEngine({ speed: 90 });
    engine.seedDefaultSpeed(200);
    expect(engine.speed).toBe(200);
  });

  it("does not seed when constructed from a persisted speed", () => {
    const { engine } = makeEngine({ speed: 90, seeded: true });
    engine.seedDefaultSpeed(200);
    expect(engine.speed).toBe(90);
  });

  it("only seeds once, so a later reconnect cannot re-seat the speed", () => {
    const { engine } = makeEngine({ speed: 90 });
    engine.seedDefaultSpeed(200);
    expect(engine.speed).toBe(200);
    engine.seedDefaultSpeed(300); // e.g. a second daemon connect
    expect(engine.speed).toBe(200);
  });

  it("treats a manual adjustSpeed as seeding, so a later reconnect cannot undo it", () => {
    const { engine } = makeEngine({ speed: 90 });
    engine.adjustSpeed(15); // user presses "+" before the daemon connects
    expect(engine.speed).toBe(105);
    engine.seedDefaultSpeed(200); // daemon connects afterwards
    expect(engine.speed).toBe(105);
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

describe("ScrollEngine direction", () => {
  it("scrolls downward by default", () => {
    const { engine, moves } = makeEngine({ speed: 100 });
    expect(engine.direction).toBe(1);
    engine.start();
    engine.tick(1000);
    engine.tick(1050);
    expect(moves).toEqual([5]);
  });

  it("scrolls upward once flipped", () => {
    const { engine, moves } = makeEngine({ speed: 100 });
    expect(engine.flipDirection()).toBe(-1);
    engine.start();
    engine.tick(1000);
    engine.tick(1050);
    expect(moves).toEqual([-5]);
  });

  it("flips back and forth", () => {
    const { engine } = makeEngine();
    engine.flipDirection();
    expect(engine.flipDirection()).toBe(1);
    expect(engine.direction).toBe(1);
  });

  it("keeps speed positive when reversed, so the display stays sane", () => {
    const { engine } = makeEngine({ speed: 100 });
    engine.flipDirection();
    engine.adjustSpeed(15);
    expect(engine.speed).toBe(115);
    expect(engine.direction).toBe(-1);
  });

  it("accumulates sub-pixel remainders upward too", () => {
    // Same binary-exact operands as the downward test: 32 px/s at 1/64 s.
    const { engine, moves } = makeEngine({ speed: 32 });
    engine.flipDirection();
    engine.start();
    engine.tick(0);
    for (let i = 1; i <= 4; i += 1) engine.tick(i * 15.625);
    expect(moves).toEqual([-1, -1]);
  });

  it("clears the remainder on a flip so it cannot lurch", () => {
    const { engine, moves } = makeEngine({ speed: 32 });
    engine.start();
    engine.tick(0);
    engine.tick(15.625); // accumulates exactly 0.5px, scrolls nothing
    expect(moves).toEqual([]);
    engine.flipDirection();
    engine.tick(31.25);
    expect(moves).toEqual([]); // a carried +0.5 would have produced -0/+1 noise
    engine.tick(46.875);
    expect(moves).toEqual([-1]);
  });
});

describe("ScrollEngine frame plumbing", () => {
  it("exposes the step it was configured with", () => {
    const { engine } = makeEngine();
    expect(engine.step).toBe(15);
  });

  it("stopping an engine that never ran reports it as stopped", () => {
    const { engine } = makeEngine();
    expect(engine.stop()).toBe(false);
    expect(engine.running).toBe(false);
  });

  it("re-arms itself through the callback it hands the browser", () => {
    const { engine, moves, frames } = makeEngine();
    engine.start();
    // The other tests call tick() directly. Driving the engine through the
    // queued callback instead is what proves it keeps asking for the next
    // frame rather than stopping after the first one.
    frames.at(-1)(1000);
    frames.at(-1)(1100);
    expect(moves).toEqual([10]);
    expect(frames).toHaveLength(3);
  });

  it("stops cleanly when the frame handle came back null", () => {
    const { engine } = makeEngine({ requestFrame: () => null });
    engine.start();
    expect(engine.stop()).toBe(false);
    expect(engine.running).toBe(false);
  });
});
