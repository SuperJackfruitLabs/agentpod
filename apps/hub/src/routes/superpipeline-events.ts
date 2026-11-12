/**
 * POST /public/bridge/superpipeline/events — gates that reach the hub through the suite's event
 * relay (treaty plan step 7), beside the board's direct push.
 *
 * The relay delivers each event as a CloudEvent in HTTP binary mode, signed with
 * `x-treaty-signature` over the timestamp, the event id and the exact body. The signature is checked
 * against `TREATY_RELAY_DELIVERY_SECRET` before the data is read, and the route fails closed
 * without the secret. A `gate.pending` goes to the same projection the direct push uses
 * (`projectPushedGate`), which is idempotent on the gate id, so a gate delivered by both doors is
 * posted once.
 *
 * Step 7 carries gates only. Any other event type is answered 200 and ignored, so the relay does
 * not retry what this build will never handle. A body that says it is a gate but is not one is
 * 422: retrying cannot fix it, and the relay drops it and logs.
 */
import { Hono } from "hono";
import { CloudEventError, fromBinary, verifyDelivery, SIGNATURE_HEADER } from "@superjackfruitlabs/treaty-cloudevents";
import { createLogger } from "../utils/logger";
import { isBoardMoved, isGatePending, type GatePendingDelivery, type GateProjectionDeps } from "../services/board-chat";
import { projectPushedGate, type SuperpipelinePushDeps } from "./superpipeline-push";

const log = createLogger("superpipeline-events");

export const GATE_PENDING_TYPE = "com.superjackfruit.superpipeline.gate.pending.v1";

export interface SuperpipelineEventsDeps extends GateProjectionDeps, Pick<SuperpipelinePushDeps, "tenantIdFor"> {
  /** The secret the event relay signs this hub's deliveries with. */
  secret: string | undefined;
  /** Test seam: what a verified gate does. Defaults to `projectPushedGate` (the push route's projection). */
  project?(body: GatePendingDelivery): Promise<{ status: 200 | 404; body: Record<string, unknown> }>;
}

export function createSuperpipelineEventsRoutes(deps: SuperpipelineEventsDeps) {
  return new Hono().post("/bridge/superpipeline/events", async (c) => {
    if (!deps.secret) {
      log.warn("event rejected: no event relay secret configured");
      return c.json({ error: "not configured" }, 503);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    let event;
    try {
      event = fromBinary({ headers: Object.fromEntries(c.req.raw.headers), body: bytes }, "http");
    } catch (e) {
      return c.json({ error: "not a CloudEvent", detail: e instanceof CloudEventError ? e.message : "unreadable" }, 400);
    }
    const id = event.attributes["id"] ?? "";
    try {
      await verifyDelivery(deps.secret, c.req.header(SIGNATURE_HEADER) ?? null, id, bytes);
    } catch {
      log.warn("event rejected: bad signature", { id });
      return c.json({ error: "bad signature" }, 401);
    }
    if (event.attributes["type"] !== GATE_PENDING_TYPE) {
      return c.json({ ok: true, ignored: true }, 200);
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return c.json({ error: "invalid json" }, 422);
    }
    if (!isGatePending(body)) {
      log.warn("a gate.pending event whose data is not a gate", { id });
      return c.json({ error: "not a gate" }, 422);
    }
    // A board whose chat has moved out of this hub (`moved-boards.ts`): 200, so the relay does not retry.
    if (isBoardMoved(body.boardId)) {
      log.info("gate for a board whose chat has moved; not posted", { id, boardId: body.boardId });
      return c.json({ ok: true, status: "moved" }, 200);
    }
    const result = deps.project ? await deps.project(body) : await projectPushedGate(body, deps, "event-relay");
    return c.json(result.body, result.status);
  });
}
