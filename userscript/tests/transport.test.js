import { describe, expect, it, vi } from "vitest";
import { nextBackoff, Transport } from "../src/transport.js";

function harness({ responses }) {
  const calls = [];
  const sleeps = [];
  let index = 0;

  const request = vi.fn(async (options) => {
    calls.push(options);
    const responder = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (typeof responder === "function") return responder(options);
    return responder;
  });

  const commands = [];
  const connection = [];
  const transport = new Transport({
    port: 8765,
    request,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onCommands: (list) => commands.push(...list),
    onConnectionChange: (ok) => connection.push(ok),
  });

  return { transport, request, calls, sleeps, commands, connection };
}

const ok = (body) => ({ status: 200, text: JSON.stringify(body) });

describe("nextBackoff", () => {
  it("starts at one second", () => {
    expect(nextBackoff(0)).toBe(1000);
  });

  it("doubles", () => {
    expect(nextBackoff(1000)).toBe(2000);
  });

  it("caps at five seconds", () => {
    expect(nextBackoff(4000)).toBe(5000);
    expect(nextBackoff(5000)).toBe(5000);
  });
});

describe("Transport", () => {
  it("fetches settings from /health before polling", async () => {
    const h = harness({
      responses: [
        ok({ ok: true, settings: { default_speed: 90 } }),
        () => {
          h.transport.stop();
          return ok({ cursor: 0, events: [] });
        },
      ],
    });
    await h.transport.start();
    expect(h.calls[0].url).toBe("http://127.0.0.1:8765/health");
    expect(h.transport.settings).toEqual({ default_speed: 90 });
  });

  it("delivers commands from a poll", async () => {
    const h = harness({
      responses: [
        ok({ ok: true, settings: {} }),
        () => {
          h.transport.stop();
          return ok({
            cursor: 2,
            events: [
              { seq: 1, command: "toggle" },
              { seq: 2, command: "faster" },
            ],
          });
        },
      ],
    });
    await h.transport.start();
    expect(h.commands).toEqual(["toggle", "faster"]);
  });

  it("advances the cursor between polls", async () => {
    const h = harness({
      responses: [
        ok({ ok: true, settings: {} }),
        ok({ cursor: 7, events: [{ seq: 7, command: "next" }] }),
        () => {
          h.transport.stop();
          return ok({ cursor: 7, events: [] });
        },
      ],
    });
    await h.transport.start();
    expect(h.calls[1].url).toContain("cursor=0");
    expect(h.calls[2].url).toContain("cursor=7");
  });

  it("reports the connection as up after a good poll", async () => {
    const h = harness({
      responses: [
        ok({ ok: true, settings: {} }),
        () => {
          h.transport.stop();
          return ok({ cursor: 0, events: [] });
        },
      ],
    });
    await h.transport.start();
    expect(h.connection.at(-1)).toBe(true);
    expect(h.transport.connected).toBe(true);
  });

  it("reports the connection as down and backs off after a failure", async () => {
    let attempts = 0;
    const h = harness({
      responses: [
        () => {
          attempts += 1;
          if (attempts >= 3) h.transport.stop();
          throw new Error("connection refused");
        },
      ],
    });
    await h.transport.start();
    expect(h.connection[0]).toBe(false);
    expect(h.transport.connected).toBe(false);
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it("treats a non-200 response as a failure", async () => {
    let attempts = 0;
    const h = harness({
      responses: [
        () => {
          attempts += 1;
          if (attempts >= 2) h.transport.stop();
          return { status: 500, text: "boom" };
        },
      ],
    });
    await h.transport.start();
    expect(h.connection[0]).toBe(false);
  });

  it("treats an unparseable body as a failure", async () => {
    let attempts = 0;
    const h = harness({
      responses: [
        () => {
          attempts += 1;
          if (attempts >= 2) h.transport.stop();
          return { status: 200, text: "{not json" };
        },
      ],
    });
    await h.transport.start();
    expect(h.connection[0]).toBe(false);
  });

  it("resets the backoff after recovering", async () => {
    let calls = 0;
    const h = harness({
      responses: [
        () => {
          calls += 1;
          if (calls === 1) throw new Error("down");
          if (calls === 2) return ok({ ok: true, settings: {} });
          if (calls === 3) return ok({ cursor: 0, events: [] });
          if (calls === 4) throw new Error("down again");
          h.transport.stop();
          return ok({ ok: true, settings: {} });
        },
      ],
    });
    await h.transport.start();
    expect(h.sleeps).toEqual([1000, 1000]);
  });

  it("only reports a connection change when it actually changes", async () => {
    const h = harness({
      responses: [
        ok({ ok: true, settings: {} }),
        ok({ cursor: 0, events: [] }),
        ok({ cursor: 0, events: [] }),
        () => {
          h.transport.stop();
          return ok({ cursor: 0, events: [] });
        },
      ],
    });
    await h.transport.start();
    expect(h.connection).toEqual([true]);
  });

  it("posts state as JSON", async () => {
    const h = harness({ responses: [ok({ ok: true })] });
    await h.transport.postState({ running: true, speed: 90 });
    expect(h.calls[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:8765/state",
      body: JSON.stringify({ running: true, speed: 90 }),
    });
  });

  it("swallows errors from posting state", async () => {
    const h = harness({
      responses: [
        () => {
          throw new Error("down");
        },
      ],
    });
    await expect(
      h.transport.postState({ running: true }),
    ).resolves.toBeUndefined();
  });

  it("stops polling once stopped", async () => {
    const h = harness({
      responses: [
        ok({ ok: true, settings: {} }),
        () => {
          h.transport.stop();
          return ok({ cursor: 0, events: [] });
        },
      ],
    });
    await h.transport.start();
    const after = h.request.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.request.mock.calls.length).toBe(after);
  });
});

describe("Transport starts from the present", () => {
  it("polls from the cursor /health reports, not from zero", async () => {
    // Starting at 0 makes the daemon replay its whole log at a page that has
    // just loaded, re-running old navigation commands.
    const h = harness({
      responses: [
        ok({ ok: true, settings: {}, cursor: 157 }),
        () => {
          h.transport.stop();
          return ok({ cursor: 157, events: [] });
        },
      ],
    });
    await h.transport.start();
    expect(h.calls[1].url).toContain("cursor=157");
  });

  it("falls back to zero when the daemon reports no cursor", async () => {
    const h = harness({
      responses: [
        ok({ ok: true, settings: {} }),
        () => {
          h.transport.stop();
          return ok({ cursor: 0, events: [] });
        },
      ],
    });
    await h.transport.start();
    expect(h.calls[1].url).toContain("cursor=0");
  });

  it("does not rewind to the health cursor after it has advanced", async () => {
    const h = harness({
      responses: [
        ok({ ok: true, settings: {}, cursor: 10 }),
        ok({ cursor: 11, events: [{ seq: 11, command: "toggle" }] }),
        () => {
          h.transport.stop();
          return ok({ cursor: 11, events: [] });
        },
      ],
    });
    await h.transport.start();
    expect(h.calls[1].url).toContain("cursor=10");
    expect(h.calls[2].url).toContain("cursor=11");
  });
});
