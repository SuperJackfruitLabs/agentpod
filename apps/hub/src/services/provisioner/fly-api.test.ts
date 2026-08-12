/**
 * Unit tests: the low-level Fly Machines HTTP client.
 *
 * No real Fly. A fake fetch captures requests and returns controlled responses,
 * including the failure bodies whose wording an operator has to act on.
 */

import { describe, it, expect } from "bun:test";
import { createFlyClient, FlyApiError, FLY_AUTH_SCHEME, noPacer } from "./fly-api";

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
