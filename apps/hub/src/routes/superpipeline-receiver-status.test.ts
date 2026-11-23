import { describe, expect, test } from "bun:test";
import { signDelivery, toBinary } from "@superjackfruitlabs/treaty-cloudevents";
import { treatyText } from "../../tests/helpers/treaty-data";

import { decisionEventType } from "./superpipeline-decisions";
import { createSuperpipelineEventsRoutes, type SuperpipelineEventsDeps } from "./superpipeline-events";
import { createSuperpipelinePushRoutes } from "./superpipeline-push";

/**
 * The receiver status contract (treaty phase 2, ruling 4; treaty `schemas/README.md`), on both
 * doors SuperPipeline's events arrive through:
 *
 * - 2xx: handled, or permanently ignored, such as an event this hub does not take;
 * - 503: transient, such as a board this hub has not mapped yet, so the sender tries again;
 * - any other 4xx: permanently refused, such as an invalid body.
 *
 * The relay drops every 4xx but 408 and 429, so an unmapped board answered 404 would be lost there.
 * And a board this hub will never map (known by neither its roster nor a dispatch, such as a board
 * SuperExchange carries) is 200 and ignored: a 503 there costs the relay every retry for nothing.
 */

const SECRET = "receiver-status-secret";
const corpus: { schemas: Record<string, { valid: Record<string, Record<string, unknown>> }> } = JSON.parse(
  treatyText("fixtures/superpipeline-events/examples.json"),
);
const examples = corpus.schemas;
const valid = (schema: string): Record<string, unknown> => {
  const first = Object.values(examples[schema]?.valid ?? {})[0];
  if (!first) throw new Error(`treaty publishes no valid ${schema}`);
  return { ...first };
};

function deps(over: Partial<SuperpipelineEventsDeps> = {}): SuperpipelineEventsDeps {
  return {
    secret: SECRET,
    domain: "id.agentpod.dev",
    tenantIdFor: async () => null,
    // The board is rostered here but never dispatched for: known, not mapped yet.
    tenantsForBoard: async () => ["tnt_rostered"],
    boardRoom: async () => null,
    sendText: async () => "$prose",
    sendCustomEvent: async () => "$gate",
    ...over,
  };
}

type Door = (d: SuperpipelineEventsDeps, data: Record<string, unknown>, type: string) => Promise<Response>;

const relay: Door = async (d, data, type) => {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const id = "brd_134a0ddb6d434478:1";
  const wire = toBinary({ attributes: { specversion: "1.0", id, source: "/superpipeline/boards/brd_134a0ddb6d434478", type, datacontenttype: "application/json" } }, "http");
  const headers = { ...wire.headers, "x-treaty-signature": await signDelivery(SECRET, id, bytes) };
  return createSuperpipelineEventsRoutes(d).request("/bridge/superpipeline/events", { method: "POST", headers, body: bytes });
};

const push: Door = async (d, data, type) => {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const id = "brd_134a0ddb6d434478:1";
  const wire = toBinary({ attributes: { specversion: "1.0", id, source: "/superpipeline/boards/brd_134a0ddb6d434478", type, datacontenttype: "application/json" } }, "http");
  const headers = { ...wire.headers, "x-treaty-signature": await signDelivery(SECRET, id, bytes) };
  const path = data.event === "work.available" ? "/bridge/superpipeline/work" : "/bridge/superpipeline/push";
  return createSuperpipelinePushRoutes({ wakeBoard: () => 0, ...d }).request(path, { method: "POST", headers, body: bytes });
};

for (const [name, door] of [["the event relay", relay], ["the direct push", push]] as const) {
  describe(`${name} follows the receiver status contract`, () => {
    test("a board this hub has not mapped yet is 503, so it is tried again", async () => {
      for (const schema of ["gate.pending.v1", "elicitation.pending.v1", "delivery.pending.v1", "attention.pending.v1"]) {
        const body = valid(schema);
        const res = await door(deps(), body, decisionEventType(String(body.event)));
        expect({ schema, status: res.status }).toEqual({ schema, status: 503 });
      }
    });

    test("a board this hub knows by neither roster nor dispatch is 200 and ignored, not retried", async () => {
      for (const schema of ["gate.pending.v1", "elicitation.pending.v1", "delivery.pending.v1", "attention.pending.v1"]) {
        const body = valid(schema);
        const res = await door(deps({ tenantsForBoard: async () => [] }), body, decisionEventType(String(body.event)));
        expect({ schema, status: res.status, body: await res.json() }).toEqual({
          schema,
          status: 200,
          body: { ok: true, status: "ignored" },
        });
      }
      const body = valid("check.failed.v1");
      const res = await door(
        deps({ tenantsForBoard: async () => [], handleCheckFailed: async () => ({ status: "unknown-board" }) }),
        body,
        decisionEventType("check.failed"),
      );
      expect(res.status).toBe(200);
    });

    test("a handler that finds no tenant for the board is 503 too", async () => {
      const body = valid("check.failed.v1");
      const res = await door(deps({ handleCheckFailed: async () => ({ status: "unknown-board" }) }), body, decisionEventType("check.failed"));
      expect(res.status).toBe(503);
    });

    test("a body a handler finds malformed is 400", async () => {
      const body = valid("check.failed.v1");
      const res = await door(deps({ handleCheckFailed: async () => ({ status: "malformed" }) }), body, decisionEventType("check.failed"));
      expect(res.status).toBe(400);
    });

    test("a decision whose data treaty's guard refuses is 400", async () => {
      const body = { ...valid("check.failed.v1"), arrivalId: "" };
      const res = await door(deps({ handleCheckFailed: async () => ({ status: "sent" }) }), body, decisionEventType("check.failed"));
      expect(res.status).toBe(400);
    });

    test("an event this hub does not take is 200 and ignored", async () => {
      const body = valid("record.v1");
      const res = await door(deps(), body, "com.superjackfruit.superpipeline.card.created.v1");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ignored: true });
    });

    test("a handled decision is 200", async () => {
      const body = valid("check.failed.v1");
      const res = await door(deps({ handleCheckFailed: async () => ({ status: "sent" }) }), body, decisionEventType("check.failed"));
      expect(res.status).toBe(200);
    });
  });
}

describe("the work door follows it as well", () => {
  test("a work.available it cannot read is 400; another event is 200 and ignored", async () => {
    expect((await push(deps(), { event: "work.available", boardId: 7 }, "com.superjackfruit.superpipeline.work.available.v1")).status).toBe(400);
    const res = await createSuperpipelinePushRoutes(deps()).request("/bridge/superpipeline/work", {
      method: "POST",
      headers: { "x-treaty-signature": await signDelivery(SECRET, "brd_1:2", new TextEncoder().encode('{"event":"cards.stale"}')), "ce-id": "brd_1:2" },
      body: '{"event":"cards.stale"}',
    });
    expect(res.status).toBe(200);
  });
});
