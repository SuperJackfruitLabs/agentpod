/**
 * Unit Tests: POST /api/nodes/:id/update
 *
 * The route brokers an "update" RPC to the node. Two things it must get right
 * (issue #296):
 *
 *   1. HTTP status must reflect whether the UPDATE happened, not whether the
 *      WebSocket round-trip happened. The route used to return the broker
 *      envelope verbatim, so a node that refused the verb answered
 *      `HTTP 200 {"ok":false,"error":"descriptor: unknown verb \"update\""}` —
 *      success to any caller that checks the status, while the node did
 *      nothing. The symptom of a silently failed update is nothing at all: the
 *      node keeps running the old binary and looks healthy.
 *
 *   2. The node's payload must survive to the caller, flattened. The real
 *      broker nests it under `data`, so `body.updating` was always undefined —
 *      a caller could not tell an update that started from one that no-opped.
 *
 * No database or live WebSocket required — the broker is injected via the
 * createNodeRoutes() factory.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import { createNodeRoutes } from "../../src/routes/nodes";
import type { AuthUser } from "../../src/auth/middleware";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER_ID = "user-unit-001";
const TEST_NODE_ID = "node-unit-abc123";

type BrokerResult = { ok: boolean; data?: unknown; error?: string };
type RequestFn = (
  nodeId: string,
  verb: string,
  params: unknown
) => Promise<BrokerResult>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal Hono test app that mounts createNodeRoutes() under
 * /api/nodes, with a fake auth middleware that stamps TEST_USER_ID on
 * every request.
 */
function makeTestApp(mockRequest: RequestFn) {
  // fixedImageNodesFn is injected for the same reason `request` is: this file
  // has no database behind it, and without the injection the route asks one
  // which nodes boot from a substrate image.
  const routes = createNodeRoutes({
    request: mockRequest,
    fixedImageNodesFn: async () => new Set<string>(),
  });

  return new Hono()
    .use("/api/nodes/*", async (c, next) => {
      c.set("user", {
        id: TEST_USER_ID,
        authType: "api_key",
        tenantId: "fleet_00000000000000000000",
      } satisfies AuthUser);
      return next();
    })
    .route("/api/nodes", routes);
}

/** A broker stub that always answers `result` and records every call. */
function stubBroker(result: BrokerResult) {
  const calls: Array<[string, string, unknown]> = [];
  const request: RequestFn = async (nodeId, verb, params) => {
    calls.push([nodeId, verb, params]);
    return result;
  };
  return { request, calls };
}

async function postUpdate(mockRequest: RequestFn, path = "") {
  return makeTestApp(mockRequest).request(
    `/api/nodes/${TEST_NODE_ID}/update${path}`,
    { method: "POST", headers: { "Content-Type": "application/json" } }
  );
}

// ─── Success path ─────────────────────────────────────────────────────────────

test("POST /api/nodes/:id/update → brokers update to the node and flattens the node's payload", async () => {
  const { request, calls } = stubBroker({
    ok: true,
    // The real broker envelope nests the node's result under `data`.
    data: { ok: true, updating: true, tag: "v0.1.26", currentVersion: "v0.1.25" },
  });

  const res = await postUpdate(request);
  expect(res.status).toBe(200);

  expect(calls).toHaveLength(1);
  const [calledNodeId, calledVerb, calledParams] = calls[0]!;
  expect(calledNodeId).toBe(TEST_NODE_ID);
  expect(calledVerb).toBe("update");
  expect(calledParams).toEqual({ force: false });

  const body = (await res.json()) as Record<string, unknown>;
  expect(body.ok).toBe(true);
  expect(body.updating).toBe(true);
  expect(body.tag).toBe("v0.1.26");
  expect(body.currentVersion).toBe("v0.1.25");
});

test("POST /api/nodes/:id/update → an already-current node is 200 with updating:false, not an implied restart", async () => {
  const { request } = stubBroker({
    ok: true,
    data: {
      ok: true,
      updating: false,
      tag: "v0.1.25",
      currentVersion: "v0.1.25",
      reason: "already up to date",
    },
  });

  const res = await postUpdate(request);
  expect(res.status).toBe(200);

  const body = (await res.json()) as Record<string, unknown>;
  expect(body.ok).toBe(true);
  // The distinguishing bit: nothing happened, and the console can say so.
  expect(body.updating).toBe(false);
  expect(body.tag).toBe("v0.1.25");
  expect(body.reason).toBe("already up to date");
});

// ─── force ────────────────────────────────────────────────────────────────────

test("POST /api/nodes/:id/update?force=1 → forwards force to the node", async () => {
  const { request, calls } = stubBroker({
    ok: true,
    data: { ok: true, updating: true, tag: "v0.1.25" },
  });

  const res = await postUpdate(request, "?force=1");
  expect(res.status).toBe(200);
  expect(calls[0]![2]).toEqual({ force: true });
  expect(((await res.json()) as Record<string, unknown>).updating).toBe(true);
});

test("POST /api/nodes/:id/update with {force:true} body → forwards force to the node", async () => {
  const { request, calls } = stubBroker({
    ok: true,
    data: { ok: true, updating: true, tag: "v0.1.25" },
  });

  const res = await makeTestApp(request).request(
    `/api/nodes/${TEST_NODE_ID}/update`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    }
  );

  expect(res.status).toBe(200);
  expect(calls[0]![2]).toEqual({ force: true });
});

// ─── Failure paths: the envelope ──────────────────────────────────────────────

test("POST /api/nodes/:id/update → a node that refuses the verb is NOT a 2xx, and its error survives", async () => {
  // Measured on the live hub 2026-08-13 against an agent predating the verb.
  const nodeError = 'descriptor: unknown verb "update"';
  const { request } = stubBroker({ ok: false, error: nodeError });

  const res = await postUpdate(request);

  // The single most important assertion in this file: the update did not
  // happen, so the status must not say it did.
  expect(res.status).not.toBe(200);
  expect(res.status).toBeGreaterThanOrEqual(400);
  // Upstream (the node) failed, not the hub — 502, matching every other
  // broker-proxying route in the hub.
  expect(res.status).toBe(502);

  const body = (await res.json()) as { ok?: boolean; error?: string };
  expect(body.ok).toBe(false);
  // The message is genuinely useful — it is the whole diagnosis — so it must
  // reach the caller verbatim rather than being flattened into status copy.
  expect(body.error).toBe(nodeError);
});

test("POST /api/nodes/:id/update → an offline node is 409, not 502 and not 200", async () => {
  const { request } = stubBroker({ ok: false, error: "node offline" });

  const res = await postUpdate(request);
  expect(res.status).toBe(409);

  const body = (await res.json()) as { ok?: boolean; error?: string };
  expect(body.ok).toBe(false);
  expect(body.error).toBe("node offline");
});

test("POST /api/nodes/:id/update → a disconnected node is 409", async () => {
  const { request } = stubBroker({ ok: false, error: "node disconnected" });
  expect((await postUpdate(request)).status).toBe(409);
});

test("POST /api/nodes/:id/update → a timeout is 502", async () => {
  const { request } = stubBroker({ ok: false, error: "timeout" });

  const res = await postUpdate(request);
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error?: string }).error).toBe("timeout");
});

// ─── Failure paths: inside the envelope ───────────────────────────────────────

test("POST /api/nodes/:id/update → a node-side failure inside a delivered envelope is 502, not 200", async () => {
  // The node reached the download and failed there. The RPC round-trip
  // succeeded (envelope ok:true) but the update did not.
  const nodeError = "selfupdate: checksum mismatch for agentpod-node-linux-arm64";
  const { request } = stubBroker({ ok: true, data: { ok: false, error: nodeError } });

  const res = await postUpdate(request);
  expect(res.status).toBe(502);

  const body = (await res.json()) as { ok?: boolean; error?: string };
  expect(body.ok).toBe(false);
  expect(body.error).toBe(nodeError);
});

// ─── Guard: the mapping must not swallow successes ────────────────────────────

test("POST /api/nodes/:id/update → a successful update is still a 200", async () => {
  for (const data of [
    { ok: true, updating: true, tag: "v0.1.26" },
    { ok: true, updating: false, tag: "v0.1.26", reason: "already up to date" },
  ]) {
    const { request } = stubBroker({ ok: true, data });
    const res = await postUpdate(request);
    expect(res.status).toBe(200);
  }
});

// ─── A node whose binary comes from an image (#349) ───────────────────────────

/**
 * `cf-opencode` was updated from the console and went offline, still on
 * v0.1.22. Self-update swaps the binary and exits so a supervisor can restart
 * it; a Cloudflare container has no supervisor, so the exit IS the stop — and
 * the swap would not have survived the restart it never got, because the next
 * start comes up from the image.
 *
 * So the refusal must happen BEFORE the RPC. A route that sent the verb and
 * reported the failure afterwards would have already stopped the station.
 */
function appWithFixedImageNode(mockRequest: RequestFn) {
  const routes = createNodeRoutes({
    request: mockRequest,
    fixedImageNodesFn: async () => new Set([TEST_NODE_ID]),
  });
  return new Hono()
    .use("/api/nodes/*", async (c, next) => {
      c.set("user", {
        id: TEST_USER_ID,
        authType: "api_key",
        tenantId: "fleet_00000000000000000000",
      } satisfies AuthUser);
      return next();
    })
    .route("/api/nodes", routes);
}

test("a node that boots from an image is refused, and the RPC is never sent", async () => {
  const { request, calls } = stubBroker({ ok: true, data: { ok: true, updating: true } });

  const res = await appWithFixedImageNode(request).request(
    `/api/nodes/${TEST_NODE_ID}/update`,
    { method: "POST", headers: { "Content-Type": "application/json" } }
  );

  expect(res.status).toBe(409);
  // Not sending it is the whole point: the send is what stops the station.
  expect(calls).toHaveLength(0);
});

test("the refusal says how to update the node instead", async () => {
  // A bare "unsupported" leaves an operator with a stale station and no next
  // step, which is how people end up destroying a runtime to fix a version.
  const { request } = stubBroker({ ok: true, data: { ok: true, updating: true } });

  const res = await appWithFixedImageNode(request).request(
    `/api/nodes/${TEST_NODE_ID}/update`,
    { method: "POST", headers: { "Content-Type": "application/json" } }
  );
  const body = (await res.json()) as { ok: boolean; error: string };

  expect(body.ok).toBe(false);
  expect(body.error).toMatch(/image/i);
  expect(body.error).toMatch(/AGENTPOD_VERSION|redeploy/i);
});

test("force does not override it, because force cannot make this work", async () => {
  const { request, calls } = stubBroker({ ok: true, data: { ok: true, updating: true } });

  const res = await appWithFixedImageNode(request).request(
    `/api/nodes/${TEST_NODE_ID}/update?force=1`,
    { method: "POST", headers: { "Content-Type": "application/json" } }
  );

  expect(res.status).toBe(409);
  expect(calls).toHaveLength(0);
});

test("an ordinary node is unaffected", async () => {
  const { request, calls } = stubBroker({
    ok: true,
    data: { ok: true, updating: true, tag: "v0.1.27" },
  });

  const res = await postUpdate(request);

  expect(res.status).toBe(200);
  expect(calls).toHaveLength(1);
});
