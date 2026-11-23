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
    projectGate: async (body: GatePendingDelivery) => {
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
    expect((await deliver(d, { data: { event: "gate.pending" } })).status).toBe(400);
    expect((await deliver(d, { data: "not json" })).status).toBe(400);
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

/**
 * Treaty phase 2: the relay is a door for every decision, not gates alone. Each of the eleven
 * types reaches the same handler the push uses, through treaty's guard, and an event the push and
 * the relay both deliver (one id, `<boardId>:<seq>`) is acted on once.
 */
import { treatyText } from "../../tests/helpers/treaty-data";
import { DECISION_EVENTS, decisionEventType } from "./superpipeline-decisions";
import { createSuperpipelinePushRoutes } from "./superpipeline-push";
import type { EventReceipts } from "../services/bridge";

const corpus: { schemas: Record<string, { valid: Record<string, Record<string, unknown>> }> } = JSON.parse(
  treatyText("fixtures/superpipeline-events/examples.json"),
);
const examples = corpus.schemas;

/** A valid body treaty publishes for each decision event, by its `event` name. */
function exampleOf(name: string): Record<string, unknown> {
  for (const schema of Object.values(examples)) {
    for (const body of Object.values(schema.valid)) {
      // A board with no moved chat, so a moved-boards setting elsewhere cannot hide the handler.
      if (body.event === name) return { ...body };
    }
  }
  throw new Error(`treaty publishes no valid ${name}`);
}

function memoryReceipts(): EventReceipts & { held: Set<string> } {
  const held = new Set<string>();
  return {
    held,
    async claim(id) {
      if (held.has(id)) return false;
      held.add(id);
      return true;
    },
    async release(id) {
      held.delete(id);
    },
  };
}

/** Every handler replaced by a recorder, so each type's arrival is seen without a room. */
function recorders() {
  const seen: string[] = [];
  const note = (name: string) => async () => {
    seen.push(name);
    return { status: "sent" as const };
  };
  const over: Partial<SuperpipelineEventsDeps> = {
    projectGate: async () => (seen.push("gate.pending"), { status: 200 as const, body: { ok: true, status: "sent" } }),
    handleDecisionTimeout: async (d) => (seen.push(d.event), { status: "sent" as const, invited: 0 }),
    handleGateApprovalRecorded: note("gate.approval_recorded"),
    handleDecisionReleased: note("decision.released"),
    handleDecisionPulledBack: note("decision.pulled_back"),
    handleCheckFailed: note("check.failed"),
    handleCheckOverridden: note("check.overridden"),
  };
  return { seen, over };
}

describe("every decision event through the relay", () => {
  test("there are eleven, and each is in treaty's catalogue", () => {
    expect(DECISION_EVENTS.length).toBe(11);
    const catalog: { events: Array<{ pushName: string; type: string }> } = JSON.parse(treatyText("schemas/catalog.json"));
    for (const name of DECISION_EVENTS) {
      expect(catalog.events.find((e) => e.pushName === name)?.type).toBe(decisionEventType(name));
    }
  });

  for (const name of ["gate.pending", "decision.reminded", "decision.escalated", "gate.approval_recorded", "decision.released", "decision.pulled_back", "check.failed", "check.overridden"]) {
    test(`${name} reaches its handler`, async () => {
      const { seen, over } = recorders();
      const { d } = deps(over);
      const res = await deliver(d, { data: exampleOf(name), type: decisionEventType(name), id: `brd_7c1f:${name}` });
      expect(res.status).toBe(200);
      expect(seen).toEqual([name]);
    });
  }

  // These three have no test seam: a board mapped to no fleet stops them at the tenant, which only a
  // handled decision asks for (an ignored type is answered before it). The board is rostered here, so
  // an unmapped one is 503 rather than ignored.
  for (const name of ["elicitation.pending", "delivery.pending", "attention.pending"]) {
    test(`${name} reaches its handler`, async () => {
      const asked: string[] = [];
      const { d } = deps({ tenantIdFor: async (b) => (asked.push(b), null), tenantsForBoard: async () => ["tnt_rostered"] });
      const body = exampleOf(name);
      const res = await deliver(d, { data: body, type: decisionEventType(name), id: `brd_7c1f:${name}` });
      expect(res.status).not.toBe(200);
      expect(asked).toEqual([String(body.boardId)]);
    });
  }

  test("a decision type whose data treaty's guard refuses is refused, not ignored", async () => {
    const { seen, over } = recorders();
    const { d } = deps(over);
    const res = await deliver(d, { data: { event: "check.failed", boardId: "brd_7c1f" }, type: decisionEventType("check.failed") });
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  test("data that is another decision than its type says is refused", async () => {
    const { seen, over } = recorders();
    const { d } = deps(over);
    const res = await deliver(d, { data: exampleOf("check.failed"), type: decisionEventType("check.overridden") });
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  test("an approval request is posted only where the push would post it", async () => {
    // An approval request belongs to no card: the board names it in `approvalRequestId` instead.
    const request: Record<string, unknown> = { ...exampleOf("elicitation.pending"), cardId: "", approvalRequestId: "apr_31d0" };
    const allowed: string[] = [];
    const rooms: string[] = [];
    const { d } = deps({
      boardRoom: async (b) => (rooms.push(b), null),
      approvalRequestAllowed: async (_t, b) => (allowed.push(b), false),
    });
    const res = await deliver(d, { data: request, type: decisionEventType("elicitation.pending") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(allowed).toEqual([String(request.boardId)]);
    expect(rooms).toEqual([]);
  });
});

describe("one event by both doors", () => {
  const PUSH_SECRET = "push-config-token";

  async function push(d: SuperpipelineEventsDeps, data: Record<string, unknown>, id: string) {
    const bytes = JSON.stringify(data);
    const name = String(data.event);
    const wire = toBinary({ attributes: { specversion: "1.0", id, source: "/superpipeline/boards/brd_7c1f", type: decisionEventType(name), datacontenttype: "application/json" } }, "http");
    const headers = { ...wire.headers, "x-treaty-signature": await signDelivery(PUSH_SECRET, id, new TextEncoder().encode(bytes)) };
    return createSuperpipelinePushRoutes({ ...d, secret: PUSH_SECRET }).request("/bridge/superpipeline/push", { method: "POST", headers, body: bytes });
  }

  test("is acted on once, whichever door is first", async () => {
    const receipts = memoryReceipts();
    const { seen, over } = recorders();
    const { d } = deps({ ...over, receipts });
    const body = exampleOf("check.failed");

    expect((await deliver(d, { data: body, type: decisionEventType("check.failed"), id: "brd_7c1f:7" })).status).toBe(200);
    const second = await push(d, body, "brd_7c1f:7");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, status: "duplicate" });

    const other = exampleOf("check.overridden");
    expect((await push(d, other, "brd_7c1f:8")).status).toBe(200);
    expect((await deliver(d, { data: other, type: decisionEventType("check.overridden"), id: "brd_7c1f:8" })).status).toBe(200);

    expect(seen).toEqual(["check.failed", "check.overridden"]);
  });

  test("a delivery that failed gives its id back, so the retry is acted on", async () => {
    const receipts = memoryReceipts();
    let fail = true;
    const seen: string[] = [];
    const { d } = deps({
      receipts,
      handleCheckFailed: async () => {
        seen.push("check.failed");
        if (fail) throw new Error("homeserver down");
        return { status: "sent" };
      },
    });
    const body = exampleOf("check.failed");
    expect((await deliver(d, { data: body, type: decisionEventType("check.failed"), id: "brd_7c1f:9" })).status).toBe(500);
    expect(receipts.held.has("brd_7c1f:9")).toBe(false);
    fail = false;
    expect((await push(d, body, "brd_7c1f:9")).status).toBe(200);
    expect(seen).toEqual(["check.failed", "check.failed"]);
  });

  test("an id the old signature carries is not believed: a board predating the move is not deduped by it", async () => {
    const receipts = memoryReceipts();
    const { seen, over } = recorders();
    const { d } = deps({ ...over, receipts });
    const raw = JSON.stringify(exampleOf("check.failed"));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(PUSH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
    const legacy = `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const res = await createSuperpipelinePushRoutes({ ...d, secret: PUSH_SECRET }).request("/bridge/superpipeline/push", {
      method: "POST",
      headers: { "content-type": "application/json", "ce-id": "brd_7c1f:10", "X-Superpipeline-Signature": legacy },
      body: raw,
    });
    expect(res.status).toBe(200);
    expect(receipts.held.size).toBe(0);
    expect(seen).toEqual(["check.failed"]);
  });
});
