import { afterEach, describe, expect, test } from "bun:test";
import { signDelivery, toBinary } from "@superjackfruitlabs/treaty-cloudevents";

import type { GatePendingDelivery } from "../services/board-chat";
import { createSuperpipelineEventsRoutes, GATE_PENDING_TYPE, type SuperpipelineEventsDeps } from "./superpipeline-events";

/**
 * The door the suite's event relay delivers gates through (treaty plan step 7). As with the push
 * door, this file is about refusing: nothing reaches the projection without the relay's signature
 * over this event's id and exact bytes. The projection itself is the push route's, covered there.
 */

const SECRET = "relay-delivery-secret";

const GATE = {
  event: "gate.pending",
  boardId: "brd_7c1f",
  boardName: "Launch",
  cardId: "crd_9a22",
  gateId: "gate_4e8b",
  stageKey: "review",
  returnStageKey: "code",
  cardTitle: "Add OAuth login",
  producedBy: "agt_31d0",
  handoffSummary: null,
  options: [{ id: "approve", label: "Approve", meaning: "approve", needsComment: false }],
  ts: "2026-11-11T00:00:00.000Z",
};

function deps(over: Partial<SuperpipelineEventsDeps> = {}) {
  const projected: GatePendingDelivery[] = [];
  // The projection is replaced by `project`, so the Matrix side is never reached.
  const d: SuperpipelineEventsDeps = {
    secret: SECRET,
    domain: "id.agentpod.dev",
    tenantIdFor: async () => "fleet_00000000000000000001",
    boardRoom: async () => null,
    sendText: async () => "$prose",
    sendCustomEvent: async () => "$gate",
    project: async (body: GatePendingDelivery) => {
      projected.push(body);
      return { status: 200 as const, body: { ok: true, status: "sent" } };
    },
    ...over,
  };
  return { d, projected };
}

async function deliver(
  d: SuperpipelineEventsDeps,
  { data = GATE, type = GATE_PENDING_TYPE, id = "brd_7c1f:1", secret = SECRET, signed = true }: Partial<{ data: unknown; type: string; id: string; secret: string; signed: boolean }> = {},
) {
  const body = new TextEncoder().encode(typeof data === "string" ? data : JSON.stringify(data));
  const wire = toBinary(
    { attributes: { specversion: "1.0", id, source: "/superpipeline/boards/brd_7c1f", type, datacontenttype: "application/json" } },
    "http",
  );
  const headers: Record<string, string> = { ...wire.headers };
  if (signed) headers["x-treaty-signature"] = await signDelivery(secret, id, body);
  return createSuperpipelineEventsRoutes(d).request("/bridge/superpipeline/events", { method: "POST", headers, body });
}

describe("the event relay's door", () => {
  test("projects a signed gate.pending with the push route's projection", async () => {
    const { d, projected } = deps();
    const res = await deliver(d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "sent" });
    expect(projected.map((g) => g.gateId)).toEqual(["gate_4e8b"]);
  });

  test("is closed without its secret", async () => {
    const { d, projected } = deps({ secret: undefined });
    expect((await deliver(d)).status).toBe(503);
    expect(projected).toEqual([]);
  });

  test("refuses an unsigned delivery", async () => {
    const { d, projected } = deps();
    expect((await deliver(d, { signed: false })).status).toBe(401);
    expect(projected).toEqual([]);
  });

  test("refuses a delivery signed with another secret", async () => {
    const { d, projected } = deps();
    expect((await deliver(d, { secret: "not-the-relay" })).status).toBe(401);
    expect(projected).toEqual([]);
  });

  test("refuses a body that is not a CloudEvent", async () => {
    const { d, projected } = deps();
    const res = await createSuperpipelineEventsRoutes(d).request("/bridge/superpipeline/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(GATE),
    });
    expect(res.status).toBe(400);
    expect(projected).toEqual([]);
  });

  test("answers another event type 200 and ignores it, so the relay does not retry it", async () => {
    const { d, projected } = deps();
    const res = await deliver(d, { type: "com.superjackfruit.superpipeline.gate.resolved.v1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(projected).toEqual([]);
  });

  test("refuses a gate.pending whose data is not a gate", async () => {
    const { d, projected } = deps();
    expect((await deliver(d, { data: { event: "gate.pending" } })).status).toBe(422);
    expect((await deliver(d, { data: "not json" })).status).toBe(422);
    expect(projected).toEqual([]);
  });
});

describe("a gate for a board whose chat has moved", () => {
  const before = process.env.BOARD_CHAT_MOVED_BOARDS;
  afterEach(() => {
    if (before === undefined) delete process.env.BOARD_CHAT_MOVED_BOARDS;
    else process.env.BOARD_CHAT_MOVED_BOARDS = before;
  });

  test("is acknowledged as moved and not projected, so the relay does not retry it", async () => {
    process.env.BOARD_CHAT_MOVED_BOARDS = "brd_7c1f";
    const { d, projected } = deps();
    const res = await deliver(d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "moved" });
    expect(projected).toEqual([]);
  });

  test("another board's gate is still projected", async () => {
    process.env.BOARD_CHAT_MOVED_BOARDS = "brd_elsewhere";
    const { d, projected } = deps();
    expect(await (await deliver(d)).json()).toEqual({ ok: true, status: "sent" });
    expect(projected.map((g) => g.gateId)).toEqual(["gate_4e8b"]);
  });
});
