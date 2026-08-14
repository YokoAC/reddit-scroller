/** Frame-rate independent auto-scrolling. */

// A backgrounded tab can produce a delta of many seconds. Cap it so the page
// does not lurch when it comes back into view.
export const MAX_FRAME_SECONDS = 0.1;

export function clampSpeed(speed, min, max) {
  if (Number.isNaN(speed)) return min;
  return Math.min(max, Math.max(min, speed));
}

export class ScrollEngine {
  constructor({
    scrollBy,
    requestFrame,
    cancelFrame,
    speed,
    min,
    max,
    step,
    // Whether `speed` already reflects a deliberate choice (typically a
    // value persisted from a previous session) rather than a placeholder
    // built-in default. See seedDefaultSpeed().
    seeded = false,
  }) {
    this._scrollBy = scrollBy;
    this._requestFrame = requestFrame;
    this._cancelFrame = cancelFrame;
    this._min = min;
    this._max = max;
    this._step = step;
    this._speed = clampSpeed(speed, min, max);
    this._seeded = seeded;
    this._direction = 1;
    this._running = false;
    this._frame = null;
    this._lastTimestamp = null;
    this._remainder = 0;
  }

  get running() {
    return this._running;
  }

  get speed() {
    return this._speed;
  }

  /** +1 scrolls down the page, -1 scrolls back up. Speed stays positive. */
  get direction() {
    return this._direction;
  }

  flipDirection() {
    this._direction = -this._direction;
    // Drop the carried fraction: it was accumulated in the other direction
    // and would otherwise discharge as a jolt on the first reversed frame.
    this._remainder = 0;
    return this._direction;
  }

  get step() {
    return this._step;
  }

  setSpeed(pxPerSecond) {
    this._speed = clampSpeed(pxPerSecond, this._min, this._max);
    this._remainder = 0;
    return this._speed;
  }

  adjustSpeed(delta) {
    // A deliberate user adjustment counts as seeding: it must not be undone
    // later by seedDefaultSpeed(), e.g. across a daemon reconnect.
    this._seeded = true;
    return this.setSpeed(this._speed + delta);
  }

  /**
   * Adopt a daemon-configured default speed — but only the first time this
   * is called on an engine that was not already seeded (by a persisted
   * speed at construction, a prior call here, or a manual adjustSpeed()).
   * Safe to call on every daemon connect/reconnect: after the first
   * application it is a no-op, so it cannot undo a live +/- adjustment.
   */
  seedDefaultSpeed(pxPerSecond) {
    if (this._seeded) return this._speed;
    this._seeded = true;
    return this.setSpeed(pxPerSecond);
  }

  /** Adopt limits reported by the daemon, re-clamping the current speed. */
  setLimits(min, max) {
    this._min = min;
    this._max = max;
    return this.setSpeed(this._speed);
  }

  start() {
    if (this._running) return true;
    this._running = true;
    this._lastTimestamp = null;
    this._remainder = 0;
    this._frame = this._requestFrame((t) => this.tick(t));
    return true;
  }

  stop() {
    if (!this._running) return false;
    this._running = false;
    if (this._frame !== null) this._cancelFrame(this._frame);
    this._frame = null;
    this._lastTimestamp = null;
    return false;
  }

  toggle() {
    return this._running ? this.stop() : this.start();
  }

  tick(timestampMs) {
    if (!this._running) return;

    if (this._lastTimestamp !== null) {
      const dt = Math.min(
        MAX_FRAME_SECONDS,
        (timestampMs - this._lastTimestamp) / 1000,
      );
      this._remainder += this._speed * this._direction * dt;
      const whole = Math.trunc(this._remainder);
      if (whole !== 0) {
        this._remainder -= whole;
        this._scrollBy(whole);
      }
    }

    this._lastTimestamp = timestampMs;
    this._frame = this._requestFrame((t) => this.tick(t));
  }
}
