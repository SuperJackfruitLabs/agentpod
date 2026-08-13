/**
 * Unit tests: the low-level Fly Machines HTTP client.
 *
 * No real Fly. A fake fetch captures requests and returns controlled responses,
 * including the failure bodies whose wording an operator has to act on.
 */

import { describe, it, expect } from "bun:test";
import {
  createFlyClient,
  createFlyPacer,
  FlyApiError,
  FLY_AUTH_SCHEME,
  noPacer,
} from "./fly-api";

function fakeFetch(response: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(response === undefined ? "" : JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

const make = (impl: typeof globalThis.fetch) =>
  createFlyClient({ token: "tok", fetchImpl: impl, pacer: noPacer });

describe("createFlyClient", () => {
  it("authenticates with the scheme measured against the real API", async () => {
    // Fly documents BOTH "FlyV1 <token>" and "Bearer <token>". This value was
    // settled by probing the live API, not by reading a page — see fly-api.ts.
    expect(FLY_AUTH_SCHEME).toBe("Bearer");

    const { impl, calls } = fakeFetch({ ok: true });
    await make(impl)("GET", "/v1/apps/demo");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("hits the machines API host and the path it was given", async () => {
    const { impl, calls } = fakeFetch({ ok: true });
    await make(impl)("GET", "/v1/apps/demo");
    expect(calls[0]!.url).toBe("https://api.machines.dev/v1/apps/demo");
  });

  it("serialises a body only when one is given", async () => {
    const withBody = fakeFetch({ id: "m1" });
    await make(withBody.impl)("POST", "/v1/apps", { app_name: "demo" });
    expect(JSON.parse(String(withBody.calls[0]!.init.body))).toEqual({ app_name: "demo" });

    const without = fakeFetch({ ok: true });
    await make(without.impl)("POST", "/v1/apps/demo/machines/m1/start");
    expect(without.calls[0]!.init.body).toBeUndefined();
  });

  it("throws a FlyApiError carrying the status, so callers can tell 408 from 500", async () => {
    const { impl } = fakeFetch({ error: "timeout reached waiting for machine state" }, 408);
    const err = (await make(impl)("GET", "/v1/apps/demo/machines/m1/wait")
      .then(() => null)
      .catch((e) => e)) as FlyApiError;
    expect(err).toBeInstanceOf(FlyApiError);
    expect(err.status).toBe(408);
    expect(err.path).toBe("/v1/apps/demo/machines/m1/wait");
  });

  it("puts Fly's own error text in the message", async () => {
    const { impl } = fakeFetch({ error: "volume not found" }, 404);
    await expect(make(impl)("GET", "/v1/apps/demo/volumes/vol_x")).rejects.toThrow(
      /volume not found/
    );
  });

  it("EXPLAINS the plan-gated region refusal instead of echoing it", async () => {
    // Measured 2026-08-12: region "bom" is refused on a non-paid plan and the
    // raw text ("legacy or non-paid plan") tells an operator nothing about
    // which knob to turn. "sin" was measured to work.
    const { impl } = fakeFetch(
      { error: "region bom is not available to legacy or non-paid plan accounts" },
      422
    );
    const message = await make(impl)("POST", "/v1/apps/demo/machines")
      .then(() => "")
      .catch((e: Error) => e.message);
    expect(message).toMatch(/FLY_REGION/);
    expect(message).toMatch(/sin/);
  });

  it("tolerates an empty body — Fly answers some verbs with no content", async () => {
    const { impl } = fakeFetch(undefined, 202);
    const res = await make(impl)("DELETE", "/v1/apps/demo");
    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
  });

  it("does not crash on a non-JSON error page", async () => {
    const impl = (async () =>
      new Response("<html>502 Bad Gateway</html>", { status: 502 })) as unknown as typeof globalThis.fetch;
    await expect(
      createFlyClient({ token: "tok", fetchImpl: impl, pacer: noPacer })("GET", "/v1/apps/demo")
    ).rejects.toThrow(/502/);
  });
});

describe("createFlyPacer", () => {
  /** A clock the test drives: sleeping advances it, so nothing waits for real. */
  function fakeClock() {
    let t = 0;
    const slept: number[] = [];
    return {
      slept,
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  it("lets a burst of three through immediately", async () => {
    // Fly's documented allowance: 1 request/second per action, burst 3. A
    // provision is four calls, so without a burst every runtime creation would
    // take four seconds of pure waiting.
    const clock = fakeClock();
    const pacer = createFlyPacer({ now: clock.now, sleep: clock.sleep });

    await pacer.take();
    await pacer.take();
    await pacer.take();

    expect(clock.slept).toEqual([]);
  });

  it("then paces at one per second", async () => {
    const clock = fakeClock();
    const pacer = createFlyPacer({ now: clock.now, sleep: clock.sleep });

    await pacer.take();
    await pacer.take();
    await pacer.take();
    await pacer.take();
    expect(clock.slept).toEqual([1000]);

    await pacer.take();
    expect(clock.slept).toEqual([1000, 1000]);
  });

  it("refills over idle time, so an idle hub never waits", async () => {
    // Without refill this would be a leaky bucket that punishes a hub for
    // having provisioned something five minutes ago.
    const clock = fakeClock();
    const pacer = createFlyPacer({ now: clock.now, sleep: clock.sleep });

    await pacer.take();
    await pacer.take();
    await pacer.take();
    clock.advance(5000);

    await pacer.take();
    await pacer.take();
    await pacer.take();
    expect(clock.slept).toEqual([]);
  });

  it("serialises concurrent callers instead of letting them all through", async () => {
    // Two runtimes provisioned at once must not each believe they own the
    // burst. take() is chained, so the fourth caller waits whoever asked.
    const clock = fakeClock();
    const pacer = createFlyPacer({ now: clock.now, sleep: clock.sleep });

    await Promise.all([
      pacer.take(),
      pacer.take(),
      pacer.take(),
      pacer.take(),
      pacer.take(),
    ]);

    expect(clock.slept).toEqual([1000, 1000]);
  });

  it("is the client's default, so no call site can forget it", async () => {
    // The default pacer waits with setTimeout. Proving that with a wall-clock
    // lower bound would put a real second into every CI run and would flake on
    // a loaded box — the suite spent PR #264 removing exactly that pattern. So
    // swap setTimeout for one that RECORDS the delay and fires immediately:
    // same evidence, no waiting, and an exact assertion instead of a fuzzy one.
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as unknown as typeof globalThis.setTimeout;

    try {
      const client = createFlyClient({
        token: "tok",
        fetchImpl: (async () =>
          new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch,
      });
      // Four calls with the real pacer: the first three ride the burst, and the
      // fourth must actually have waited.
      await client("GET", "/v1/apps/a");
      await client("GET", "/v1/apps/a");
      await client("GET", "/v1/apps/a");
      await client("GET", "/v1/apps/a");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    expect(delays.length).toBe(1);
    // Not exactly 1000: the default clock is Date.now(), and the handful of
    // real milliseconds the first three calls took is deducted from the wait.
    expect(delays[0]!).toBeGreaterThan(900);
    expect(delays[0]!).toBeLessThanOrEqual(1000);
  });
});
