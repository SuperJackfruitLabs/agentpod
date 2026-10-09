import { expect, test } from "bun:test";
import { createSuperlibraryClient } from "./client";

function fakePlane() {
  const calls: string[] = [];
  return {
    calls,
    plane: {
      serviceToken: async (aud: string | string[]) => { calls.push(`service ${aud}`); return { accessToken: "svc-tok", expiresIn: 300 }; },
      agentToken: async (prn: string, aud: string | string[]) => { calls.push(`agent ${prn} ${aud}`); return { accessToken: `agent-tok-${prn.slice(-2)}`, expiresIn: 300 }; },
    },
  };
}
const A1 = "prn_000000000000000000a1";
const A2 = "prn_000000000000000000a2";
const base = { url: "https://lib.test", audience: "https://lib.test" };

test("a service call carries the hub's token, names the agent it acts for, and proves it with the agent's own token", async () => {
  const seen: Request[] = [];
  const { plane, calls } = fakePlane();
  const c = createSuperlibraryClient({ ...base, plane, fetch: async (r) => { seen.push(r); return new Response("{}"); } });
  await c.asService({ principal: A2, kind: "agent" }).request("POST", "/api/v1/uploads", { json: { title: "x" } });
  expect(seen[0]!.url).toBe("https://lib.test/api/v1/uploads");
  expect(seen[0]!.headers.get("authorization")).toBe("Bearer svc-tok");
  expect(seen[0]!.headers.get("x-on-behalf-of")).toBe(A2);
  expect(seen[0]!.headers.get("x-on-behalf-kind")).toBe("agent");
  expect(seen[0]!.headers.get("x-on-behalf-token")).toBe("agent-tok-a2");
  expect(calls).toContain(`agent ${A2} https://lib.test`);
});

test("the on-behalf token is the named agent's own", async () => {
  const seen: Request[] = [];
  const { plane } = fakePlane();
  const c = createSuperlibraryClient({ ...base, plane, fetch: async (r) => { seen.push(r); return new Response("{}"); } });
  await c.asService({ principal: A1, kind: "agent" }).request("GET", "/x");
  await c.asService({ principal: A2, kind: "agent" }).request("GET", "/x");
  expect(seen.map((r) => [r.headers.get("x-on-behalf-of"), r.headers.get("x-on-behalf-token")])).toEqual([
    [A1, "agent-tok-a1"],
    [A2, "agent-tok-a2"],
  ]);
});

test("asService never names a person", () => {
  const c = createSuperlibraryClient({ ...base, plane: fakePlane().plane, fetch: async () => new Response("{}") });
  // Never called: the guard is the compiler. If the type is widened, the directive below is unused and typecheck fails.
  const neverCalled = () => {
    // @ts-expect-error a human is never named
    c.asService({ principal: A1, kind: "human" });
  };
  expect(typeof neverCalled).toBe("function");
});

test("an agent call uses the agent's own token and no on-behalf headers", async () => {
  const seen: Request[] = [];
  const { plane, calls } = fakePlane();
  const c = createSuperlibraryClient({ ...base, plane, fetch: async (r) => { seen.push(r); return new Response("{}"); } });
  await c.asAgent(A2).request("POST", "/api/v1/related", { json: { cardId: "card_00000000000000c1" } });
  expect(calls).toEqual([`agent ${A2} https://lib.test`]);
  expect(seen[0]!.headers.get("authorization")).toBe("Bearer agent-tok-a2");
  expect(seen[0]!.headers.get("x-on-behalf-of")).toBeNull();
  expect(seen[0]!.headers.get("x-on-behalf-token")).toBeNull();
});

test("tokens are reused until near expiry", async () => {
  const { plane, calls } = fakePlane();
  const c = createSuperlibraryClient({ ...base, plane, fetch: async () => new Response("{}") });
  const s = c.asService({ principal: A1, kind: "agent" });
  await s.request("GET", "/api/v1/me");
  await s.request("GET", "/api/v1/me");
  expect(calls.filter((x) => x.startsWith("service"))).toHaveLength(1);
  expect(calls.filter((x) => x.startsWith("agent"))).toHaveLength(1);
});

test("a slow call is cut at its timeout", async () => {
  const { plane } = fakePlane();
  const c = createSuperlibraryClient({ ...base, plane, fetch: (r) => new Promise((_, rej) => r.signal.addEventListener("abort", () => rej(new Error("aborted")))) });
  const t0 = Date.now();
  await expect(c.asAgent(A2).request("GET", "/x", { timeoutMs: 50 })).rejects.toThrow();
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("invalidateRoster is a service call for itself and never throws", async () => {
  const seen: Request[] = [];
  const { plane } = fakePlane();
  const ok = createSuperlibraryClient({ ...base, plane, fetch: async (r) => { seen.push(r); return new Response("{}"); } });
  await ok.invalidateRoster(A2);
  expect(seen[0]!.url).toBe("https://lib.test/api/v1/roster/invalidate");
  expect(seen[0]!.headers.get("authorization")).toBe("Bearer svc-tok");
  expect(seen[0]!.headers.get("x-on-behalf-of")).toBeNull();
  expect(seen[0]!.headers.get("x-on-behalf-kind")).toBeNull();
  expect(seen[0]!.headers.get("x-on-behalf-token")).toBeNull();
  expect(await seen[0]!.json()).toEqual({ principal: A2 });
  const down = createSuperlibraryClient({ ...base, plane, fetch: async () => { throw new Error("down"); } });
  await expect(down.invalidateRoster(A2)).resolves.toBeUndefined();
});
