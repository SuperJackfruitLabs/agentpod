/**
 * POST /public/bridge/superpipeline/events — decisions that reach the hub through the suite's event
 * relay, beside the board's direct push.
 *
 * The relay delivers each event as a CloudEvent in HTTP binary mode, signed with
 * `x-treaty-signature` over the timestamp, the event id and the exact body. The signature is checked
 * against `TREATY_RELAY_DELIVERY_SECRET` before the data is read, and the route fails closed
 * without the secret.
 *
 * Since treaty phase 2 it takes all eleven decision types (`DECISION_EVENTS`), not `gate.pending`
 * alone, and hands each to the same handler the push uses (`handleDecisionOnce`), which claims the
 * event's id first: an event delivered by both doors is acted on once.
 *
 * Any other event type is answered 200 and ignored, so the relay does not retry what this build
 * will never handle. A body that says it is a decision but is not one is 422: retrying cannot fix
 * it, and the relay drops it and logs.
 */
import { Hono } from "hono";
import { CloudEventError, fromBinary, verifyDelivery, SIGNATURE_HEADER } from "@superjackfruitlabs/treaty-cloudevents";
import { createLogger } from "../utils/logger";
import { DECISION_TYPES, handleDecisionOnce, type DecisionDeps } from "./superpipeline-decisions";

const log = createLogger("superpipeline-events");

export const GATE_PENDING_TYPE = "com.superjackfruit.superpipeline.gate.pending.v1";

export interface SuperpipelineEventsDeps extends DecisionDeps {
  /** The secret the event relay signs this hub's deliveries with. */
  secret: string | undefined;
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
    const name = DECISION_TYPES.get(event.attributes["type"] ?? "");
    if (!name) {
      return c.json({ ok: true, ignored: true }, 200);
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return c.json({ error: "invalid json" }, 422);
    }
    // The type names the decision, and the data must be that decision: a body whose `event` says
    // something else would otherwise be handled as whatever it claims to be.
    const said = typeof body === "object" && body !== null && "event" in body ? body.event : undefined;
    if (said !== name) {
      log.warn("a decision event whose data is another event", { id, type: event.attributes["type"], event: said });
      return c.json({ error: "data does not match type" }, 422);
    }
    const result = await handleDecisionOnce(id === "" ? null : id, body, deps, "event-relay");
    // On this door the type already said which decision it is, so data treaty's guard refuses is
    // wrong data, and a retry will not fix it.
    if (result.invalid) {
      log.warn("a decision event whose data treaty's guard refuses", { id, type: event.attributes["type"] });
      return c.json({ error: "not a valid decision" }, 422);
    }
    return c.json(result.body, result.status);
  });
}
