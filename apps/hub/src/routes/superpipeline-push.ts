/**
 * POST /public/bridge/superpipeline/push — how a board tells the hub a gate is open.
 *
 * **Public**, and mounted outside `/api/*` deliberately: the caller is a
 * Cloudflare Worker holding a shared signing secret, not a browser holding a
 * session, and `/api/*` carries the CSRF middleware — which passes a `Bearer`
 * header and would reject this. `/public` is where this codebase already puts
 * "a machine with a secret" (see `runtime-callback.ts`), so it goes there
 * rather than carving an exemption into a security middleware.
 *
 * Authentication is the suite's delivery signature, `x-treaty-signature`: HMAC-SHA256 over
 * `<t>.<ce-id>.<body>` with the push config's token as the secret, inside a 300 s window
 * (treaty `signDelivery`; the relay signs the same way). The push now arrives in CloudEvents
 * binary mode with the event's id in `ce-id`, so the signature binds the id and bounds a replay.
 *
 * It is the only signature accepted. SuperPipeline's older `X-Superpipeline-Signature` (an HMAC
 * over the bytes alone, with no id and no timestamp) stopped being sent in its v0.0.37, and a push
 * carrying only that header is now refused as unsigned. The bytes are read once and verified before
 * being parsed, because a signature over a re-serialized object is a signature over something the
 * sender never sent.
 *
 * Fails closed with no configured secret: an unset secret must never mean
 * "accept anything", which is the shape of the mistake that makes a webhook a
 * public write endpoint.
 */

import { Hono, type Context } from "hono";
import { SIGNATURE_HEADER, verifyDelivery } from "@superjackfruitlabs/treaty-cloudevents";

import { createLogger } from "../utils/logger";
import { isWorkAvailable, wakeBoard } from "../services/bridge";
import { handleDecisionOnce, type DecisionDeps } from "./superpipeline-decisions";

const log = createLogger("superpipeline-push");

export interface SuperpipelinePushDeps extends DecisionDeps {
  /** The signing secret shared with the board's push config. */
  secret: string | undefined;
  /** Test seam: wake a board's claim loops on `work.available`. Defaults to the bridge's `wakeBoard`. */
  wakeBoard?(boardId: string): number;
  /** Test seam: the clock `x-treaty-signature`'s window is read against, in ms. Defaults to `Date.now`. */
  now?(): number;
}

/**
 * A signed delivery's parsed body, or the refusal to send instead. Fails closed with no secret;
 * reads the bytes once, verifies those, and only then parses them.
 *
 * `eventId` is the delivery's `ce-id`, which `x-treaty-signature` vouches for; null when it is empty.
 */
async function signedBody(
  secret: string | undefined,
  c: Context,
  nowMs: number,
): Promise<{ body: unknown; eventId: string | null } | { refusal: Response }> {
  if (!secret) {
    log.warn("push rejected: no signing secret configured");
    return { refusal: c.json({ error: "not configured" }, 503) };
  }
  const treatySignature = c.req.header(SIGNATURE_HEADER);
  if (treatySignature === undefined) return { refusal: c.json({ error: "unsigned" }, 401) };
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const id = c.req.header("ce-id") ?? "";
  try {
    await verifyDelivery(secret, treatySignature, id, bytes, { nowMs });
  } catch {
    log.warn("push rejected: bad x-treaty-signature", { id, bytes: bytes.length });
    return { refusal: c.json({ error: "bad signature" }, 401) };
  }
  const eventId = id === "" ? null : id;
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)), eventId };
  } catch {
    // A retry does not fix malformed JSON, so this is terminal on purpose.
    return { refusal: c.json({ error: "invalid json" }, 400) };
  }
}

export function createSuperpipelinePushRoutes(deps: SuperpipelinePushDeps) {
  return new Hono()
  /**
   * POST /public/bridge/superpipeline/work — a board saying a card one of this hub's agents can
   * claim is ready (`work.available`). Its own door, because each rostered agent registers its own
   * config here (`push-subscription.ts`) and a config is keyed by agent and url: sharing the chat
   * door's url would overwrite a board's chat subscription. Every idle loop on the board claims at
   * once; the board decides which card, if any, each one gets. 200 whether or not a loop was
   * waiting, since a retry would wake nothing more.
   */
  .post("/bridge/superpipeline/work", async (c) => {
    const signed = await signedBody(deps.secret, c, deps.now ? deps.now() : Date.now());
    if ("refusal" in signed) return signed.refusal;
    if (!isWorkAvailable(signed.body)) {
      // Ruling 4: a work.available this build cannot read is refused (a retry sends the same bytes);
      // any other event is acknowledged and ignored.
      const said = typeof signed.body === "object" && signed.body !== null && "event" in signed.body ? signed.body.event : undefined;
      if (said === "work.available") return c.json({ error: "invalid body", event: said }, 400);
      return c.json({ ok: true, ignored: true }, 200);
    }
    const boardId = signed.body.boardId;
    const woken = deps.wakeBoard ? deps.wakeBoard(boardId) : wakeBoard(boardId);
    log.info("work available; claim loops woken", { boardId: signed.body.boardId, woken });
    return c.json({ ok: true, woken }, 200);
  })
  .post("/bridge/superpipeline/push", async (c) => {
    const signed = await signedBody(deps.secret, c, deps.now ? deps.now() : Date.now());
    if ("refusal" in signed) return signed.refusal;
    const result = await handleDecisionOnce(signed.eventId, signed.body, deps, "push");
    return c.json(result.body, result.status);
  });
}
