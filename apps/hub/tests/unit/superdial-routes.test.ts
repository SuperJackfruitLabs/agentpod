/**
 * The hub's two superdial routes, under `/internal/superdial` (C4 and C6).
 *
 * Machine callers holding shared secrets, so each route is its own door: a bearer compared in
 * constant time, a malformed body refused, and nothing that leaks which part was wrong.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createSuperdialRoutes } from "../../src/routes/superdial";
import type { Calls } from "../../src/services/matrix-as";

const TURN = "8d3b0a52-1c51-4c2b-9b55-2f1e0b4a6f10";
const ROOM = "!call:id.agentpod.dev";

function app(opts: { calls?: "on" | "off"; agentToken?: string; membershipToken?: string } = {}) {
  const cancels: Array<{ turnId: string; roomId: string }> = [];
  const calls =
    opts.calls === "off"
      ? null
      : {
          cancelTurn: async (turnId: string, roomId: string) => void cancels.push({ turnId, roomId }),
          membership: async () => ({ allowed: false as const, reason: "not_member" as const }),
        };
  const routes = createSuperdialRoutes({
    agentToken: opts.agentToken ?? "loopback-secret",
    membershipToken: opts.membershipToken ?? "membership-secret",
    calls,
  });
  return { app: new Hono().route("/internal/superdial", routes), cancels };
}

function cancel(a: Hono, body: unknown, auth: string | null = "Bearer loopback-secret") {
  return a.request(`/internal/superdial/turns/${TURN}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /internal/superdial/turns/{turn_id}/cancel", () => {
  test("cancels the turn in the room it names", async () => {
    const { app: a, cancels } = app();
    const res = await cancel(a, { room_id: ROOM });
    expect(res.status).toBe(204);
    expect(cancels).toEqual([{ turnId: TURN, roomId: ROOM }]);
  });

  test("a wrong, missing or membership bearer is 401 and cancels nothing", async () => {
    const { app: a, cancels } = app();
    for (const auth of ["Bearer nope", null, "Bearer membership-secret", "loopback-secret"]) {
      expect((await cancel(a, { room_id: ROOM }, auth)).status).toBe(401);
    }
    expect(cancels).toEqual([]);
  });

  test("an unconfigured token refuses everyone, even an empty bearer", async () => {
    const { app: a } = app({ agentToken: "" });
    expect((await cancel(a, { room_id: ROOM }, "Bearer ")).status).toBe(401);
  });

  test("a body without a room is 400", async () => {
    const { app: a, cancels } = app();
    expect((await cancel(a, {})).status).toBe(400);
    expect((await cancel(a, "not json")).status).toBe(400);
    expect((await cancel(a, { room_id: 7 })).status).toBe(400);
    expect(cancels).toEqual([]);
  });

  test("with calls off it answers 204 and stops nothing", async () => {
    const { app: a } = app({ calls: "off" });
    expect((await cancel(a, { room_id: ROOM })).status).toBe(204);
  });
});

function membershipApp(answer: Calls["membership"], on = true) {
  const asked: Array<{ userId: string; roomId: string }> = [];
  const routes = createSuperdialRoutes({
    agentToken: "loopback-secret",
    membershipToken: "membership-secret",
    calls: on
      ? {
          cancelTurn: async () => {},
          membership: async (input) => {
            asked.push(input);
            return answer(input);
          },
        }
      : null,
  });
  return { app: new Hono().route("/internal/superdial", routes), asked };
}

function ask(a: Hono, body: unknown, auth: string | null = "Bearer membership-secret") {
  return a.request("/internal/superdial/membership", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ALLOWED = { allowed: true as const, agent_user_id: "@agent_ada:id.agentpod.dev", station_id: "station_ada" };


describe("POST /internal/superdial/membership", () => {
  test("answers what the check answers", async () => {
    const { app: a, asked } = membershipApp(async () => ALLOWED);
    const res = await ask(a, { user_id: "@rakesh:id.agentpod.dev", room_id: ROOM });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ALLOWED);
    expect(asked).toEqual([{ userId: "@rakesh:id.agentpod.dev", roomId: ROOM }]);
  });

  test("calls off: calls_disabled", async () => {
    const { app: a } = membershipApp(async () => ALLOWED, false);
    const res = await ask(a, { user_id: "@rakesh:id.agentpod.dev", room_id: ROOM });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: false, reason: "calls_disabled" });
  });

  test("a wrong or missing bearer, or the agent's, is 401", async () => {
    const { app: a, asked } = membershipApp(async () => ALLOWED);
    for (const auth of ["Bearer nope", null, "Bearer loopback-secret"]) {
      expect((await ask(a, { user_id: "@p:s", room_id: ROOM }, auth)).status).toBe(401);
    }
    expect(asked).toEqual([]);
  });

  test("an unconfigured token refuses everyone", async () => {
    const routes = createSuperdialRoutes({ agentToken: "x", membershipToken: "", calls: null });
    const a = new Hono().route("/internal/superdial", routes);
    expect((await ask(a, { user_id: "@p:s", room_id: ROOM }, "Bearer ")).status).toBe(401);
  });

  test("a body without both ids is 400", async () => {
    const { app: a, asked } = membershipApp(async () => ALLOWED);
    for (const body of [{}, { user_id: "@p:s" }, { room_id: ROOM }, { user_id: 1, room_id: ROOM }, "nope"]) {
      expect((await ask(a, body)).status).toBe(400);
    }
    expect(asked).toEqual([]);
  });

  test("a check that could not be answered is 503, never an allow or a not_member", async () => {
    const { app: a } = membershipApp(async () => {
      throw new Error("matrix member state failed: 502");
    });
    const res = await ask(a, { user_id: "@rakesh:id.agentpod.dev", room_id: ROOM });
    expect(res.status).toBe(503);
    expect(await res.json()).not.toHaveProperty("allowed");
  });
});
