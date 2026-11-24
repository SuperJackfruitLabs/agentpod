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

test("an isolated transport uses only the registered resource for both tokens", async () => {
  const { plane, calls } = fakePlane();
  const seen: Request[] = [];
  const client = createSuperlibraryClient({
    url: "http://127.0.0.1:8794",
    audience: "https://library.superjackfruit.com/",
    plane,
    fetch: async (r) => { seen.push(r); return new Response("{}", { status: 403 }); },
  });
  const response = await client.asService({ principal: A1, kind: "agent" }).request("POST", "/api/v1/uploads", { json: {} });
  expect(response.status).toBe(403);
  expect(seen.map((r) => r.url)).toEqual(["http://127.0.0.1:8794/api/v1/uploads"]);
  expect(calls).toEqual([
    "service https://library.superjackfruit.com/",
    `agent ${A1} https://library.superjackfruit.com/`,
  ]);
});

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

test("warmAgent mints the agent's token once, the next call reuses it, and a failing mint never throws", async () => {
  const { plane, calls } = fakePlane();
  const c = createSuperlibraryClient({ ...base, plane, fetch: async () => new Response("{}") });
  await c.warmAgent(A1);
  await c.asAgent(A1).request("POST", "/api/v1/related", { json: {} });
  expect(calls).toEqual([`agent ${A1} https://lib.test`]);
  const bad = createSuperlibraryClient({ ...base, plane: { ...plane, agentToken: async () => { throw new Error("down"); } }, fetch: async () => new Response("{}") });
  await bad.warmAgent(A2);
});

test("a warm-up in flight and the call that follows it share one mint, and a failed mint is not cached", async () => {
  const { plane, calls } = fakePlane();
  const slow = { ...plane, agentToken: async (prn: string, aud: string | string[]) => { await new Promise((r) => setTimeout(r, 50)); return plane.agentToken(prn, aud); } };
  const c = createSuperlibraryClient({ ...base, plane: slow, fetch: async () => new Response("{}") });
  const warm = c.warmAgent(A1);
  await c.asAgent(A1).request("POST", "/api/v1/related", { json: {} });
  await warm;
  expect(calls).toEqual([`agent ${A1} https://lib.test`]);

  let n = 0;
  const flaky = { ...plane, agentToken: async () => { if (n++ === 0) throw new Error("down"); return { accessToken: "t", expiresIn: 300 }; } };
  const f = createSuperlibraryClient({ ...base, plane: flaky, fetch: async () => new Response("{}") });
  await f.warmAgent(A2);
  expect((await f.asAgent(A2).request("POST", "/x", { json: {} })).ok).toBe(true);
  expect(n).toBe(2);
});

// ─── Treaty's superlibrary.api contract (phase 3): every answer checked, none changed ─────────────

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installedDataDir } from "@superjackfruitlabs/treaty-contracts/node";
import type { ContractRefusal } from "./contract";

type Cases = { valid: Record<string, unknown>; invalid: Array<{ why: string; body: unknown }> };
const libraryCases: { operations: Record<string, { responses?: Record<string, Cases> }> } = JSON.parse(
  readFileSync(join(installedDataDir(), "fixtures/http/superlibrary/api.v1.cases.json"), "utf8"),
);

/** The calls the hub makes, as it makes them. */
const CALLS = {
  createUpload: ["POST", "/api/v1/uploads"],
  putUploadFile: ["PUT", "/api/v1/uploads/upl_0123456789abcdef/files?path=execution-evidence.json"],
  commitUpload: ["POST", "/api/v1/uploads/upl_0123456789abcdef/commit"],
  verifyUpload: ["POST", "/api/v1/uploads/upl_0123456789abcdef/verification"],
  relatedWork: ["POST", "/api/v1/related"],
} as const;

/** A client whose SuperLibrary answers `status` with `body`, and the refusals it reported. */
function answering(status: number, body: string) {
  const refusals: Array<ContractRefusal & { method: string; path: string }> = [];
  const c = createSuperlibraryClient({
    ...base,
    plane: fakePlane().plane,
    fetch: async () => new Response(status === 204 ? null : body, { status, headers: { "content-type": "application/json" } }),
    onContractRefusal: (r) => refusals.push(r),
  });
  return { caller: c.asService({ principal: A1, kind: "agent" }), refusals };
}

for (const [operationId, [method, path]] of Object.entries(CALLS)) {
  const responses = libraryCases.operations[operationId]?.responses ?? {};
  test(`${operationId}: treaty's cases are checked, and every answer reaches its caller unchanged`, async () => {
    expect(Object.keys(responses).length).toBeGreaterThan(0);
    for (const [status, cases] of Object.entries(responses)) {
      for (const [name, body] of Object.entries(cases.valid)) {
        const { caller, refusals } = answering(Number(status), JSON.stringify(body));
        const res = await caller.request(method, path, { json: {} });
        expect({ name, refusals }).toEqual({ name, refusals: [] });
        expect(await res.json()).toEqual(body);
      }
      for (const { why, body } of cases.invalid) {
        const { caller, refusals } = answering(Number(status), JSON.stringify(body));
        const res = await caller.request(method, path, { json: {} });
        expect({ why, refused: refusals.map((r) => [r.operationId, r.status]) }).toEqual({ why, refused: [[operationId, Number(status)]] });
        expect(res.status).toBe(Number(status));
        expect(await res.json()).toEqual(body);
      }
    }
  });
}

test("roster invalidation's 204 is the contract's", async () => {
  const { caller, refusals } = answering(204, "");
  expect((await caller.request("POST", "/api/v1/roster/invalidate", { json: { principal: A1 } })).status).toBe(204);
  expect(refusals).toEqual([]);
});

test("a status the contract does not hold, or a body that is not JSON, is reported and still handed on", async () => {
  const teapot = answering(418, JSON.stringify({ error: "teapot" }));
  expect((await teapot.caller.request("POST", "/api/v1/related", { json: {} })).status).toBe(418);
  expect(teapot.refusals.map((r) => r.operationId)).toEqual(["relatedWork"]);

  const html = answering(200, "<html>gateway</html>");
  expect(await (await html.caller.request("POST", "/api/v1/related", { json: {} })).text()).toBe("<html>gateway</html>");
  expect(html.refusals).toEqual([{ operationId: "relatedWork", status: 200, errors: ["the body is not JSON"], method: "POST", path: "/api/v1/related" }]);
});

test("a route the contract does not hold is not checked", async () => {
  const { caller, refusals } = answering(200, "not json");
  await caller.request("POST", "/api/v1/search", { json: {} });
  await caller.request("GET", "/api/v1/library/itm_1");
  expect(refusals).toEqual([]);
});
