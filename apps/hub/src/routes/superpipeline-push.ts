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
 * Authentication is superpipeline's own outbound signature — HMAC-SHA256 over the
 * exact request bytes, `sha256=<hex>` in `X-Superpipeline-Signature`, the same
 * scheme its inbound GitHub verifier uses. The bytes are read once and hashed
 * before being parsed, because a signature over a re-serialized object is a
 * signature over something the sender never sent.
 *
 * Fails closed with no configured secret: an unset secret must never mean
 * "accept anything", which is the shape of the mistake that makes a webhook a
 * public write endpoint.
 */

import { Hono } from "hono";

import { createLogger } from "../utils/logger";
import {
  isGatePending,
  projectGate,
  type GateProjectionDeps,
} from "../services/matrix-as";
import { isApprovalRequest, isElicitationPending } from "../services/matrix-as";
import { projectElicitation } from "../services/matrix-as";
import { isDeliveryPending, projectDelivery } from "../services/matrix-as";
import { isAttentionPending, projectAttention } from "../services/matrix-as";
import type { AttentionProjectionDeps } from "../services/matrix-as";
import { handleDecisionTimeout, isDecisionTimeout } from "../services/matrix-as";
import type { DecisionNoticeDeps, DecisionNoticeOutcome } from "../services/matrix-as";
import type { DecisionTimeoutDelivery } from "../services/bridge";

const log = createLogger("superpipeline-push");

export interface SuperpipelinePushDeps extends GateProjectionDeps {
  /** The signing secret shared with the board's push config. */
  secret: string | undefined;
  /** Which fleet this board's gates belong to. */
  tenantIdFor(boardId: string): Promise<string | null>;
  /** A posted waiting card goes on the board's humans' fleet Live Activity (`boardProjectionDeps`). */
  onAttentionPosted?: AttentionProjectionDeps["onAttentionPosted"];
  /**
   * May a SuperToolkit approval request on `boardId` be posted into `tenantId`'s room — the tenant
   * this push is routed to? True only when the relay is that workspace's and no other tenant knows
   * the board (`relay-scope.ts`). Absent: no approval request is ever posted from a push.
   */
  approvalRequestAllowed?(tenantId: string, boardId: string): Promise<boolean>;
  /** Invite a workspace admin into a board room when a decision escalates (`boardProjectionDeps`). */
  invite?: DecisionNoticeDeps["invite"];
  /** A tenant's workspace owners and admins, as Matrix ids (`boardProjectionDeps`). */
  workspaceAdmins?: DecisionNoticeDeps["workspaceAdmins"];
  /** Test seam: what a reminder or escalation does. Defaults to `handleDecisionTimeout`. */
  handleDecisionTimeout?(d: DecisionTimeoutDelivery): Promise<DecisionNoticeOutcome>;
}

const enc = new TextEncoder();

async function signatureMatches(secret: string, raw: string, header: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  const expected = `sha256=${[...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
  if (expected.length !== header.length) return false;
  // Constant time: a length-independent early return leaks the prefix, which is
  // enough to forge a signature one nibble at a time.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  }
  return diff === 0;
}

export function createSuperpipelinePushRoutes(deps: SuperpipelinePushDeps) {
  return new Hono().post("/bridge/superpipeline/push", async (c) => {
    if (!deps.secret) {
      log.warn("push rejected: no signing secret configured");
      return c.json({ error: "not configured" }, 503);
    }

    const signature = c.req.header("X-Superpipeline-Signature");
    if (!signature) return c.json({ error: "unsigned" }, 401);

    // Read the bytes once, verify those, and only then parse them.
    const raw = await c.req.text();
    if (!(await signatureMatches(deps.secret, raw, signature))) {
      log.warn("push rejected: bad signature", { bytes: raw.length });
      return c.json({ error: "bad signature" }, 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      // A retry does not fix malformed JSON, so this is terminal on purpose.
      return c.json({ error: "invalid json" }, 400);
    }

    /**
     * An agent's question travels the same door as a gate.
     *
     * Both are "a person must answer before this card moves", both are signed the
     * same way, and both are refused the same way when the shape is not one this
     * build knows. Checked before the gate so the two predicates cannot both claim a
     * body — they are disjoint today, and a future field that made them overlap
     * should fail here rather than project twice.
     */
    if (isElicitationPending(body)) {
      const tenantId = await deps.tenantIdFor(body.boardId);
      if (!tenantId) {
        log.warn("push for a board mapped to no fleet", { boardId: body.boardId });
        return c.json({ error: "unknown board" }, 404);
      }
      // An approval request carries every argument in full: it goes only into the room of the
      // relay's own workspace. Dropped (200: a retry would not change it), and said in the log.
      if (isApprovalRequest(body) && !(await deps.approvalRequestAllowed?.(tenantId, body.boardId))) {
        log.warn("an approval request was pushed for a board the relay does not serve here; not posted", {
          boardId: body.boardId,
          elicitationId: body.elicitationId,
        });
        return c.json({ ok: true, ignored: true }, 200);
      }
      const outcome = await projectElicitation(tenantId, body, deps);
      log.info("question projected", {
        elicitationId: body.elicitationId,
        status: outcome.status,
      });
      return c.json({ ok: true, status: outcome.status }, 200);
    }

    /**
     * The follow-up a manual-delivery approval owes (charter: "The decision envelope covers
     * questions and follow-ups" §3), through the same door and refused the same way. Disjoint
     * from the other two by `event`.
     */
    if (isDeliveryPending(body)) {
      const tenantId = await deps.tenantIdFor(body.boardId);
      if (!tenantId) {
        log.warn("push for a board mapped to no fleet", { boardId: body.boardId });
        return c.json({ error: "unknown board" }, 404);
      }
      const outcome = await projectDelivery(tenantId, body, deps);
      log.info("delivery follow-up projected", { gateId: body.gateId, status: outcome.status });
      return c.json({ ok: true, status: outcome.status }, 200);
    }

    /**
     * A card waiting on a person (charter: "Waiting cards and broker approvals reach chat" §1),
     * through the same door and refused the same way. Disjoint from the others by `event`.
     */
    if (isAttentionPending(body)) {
      const tenantId = await deps.tenantIdFor(body.boardId);
      if (!tenantId) {
        log.warn("push for a board mapped to no fleet", { boardId: body.boardId });
        return c.json({ error: "unknown board" }, 404);
      }
      const outcome = await projectAttention(tenantId, body, deps);
      log.info("waiting card projected", { cardId: body.cardId, waitId: body.waitId, status: outcome.status });
      return c.json({ ok: true, status: outcome.status }, 200);
    }

    /**
     * A waiting decision passed its stage's timeout (charter: "Unanswered decisions remind, then
     * escalate" §2-3): a reply to the card this hub posted, and on escalation the workspace admins
     * invited. The board each picks by its own tenant rule (`decision-notices.ts`), so no
     * `tenantIdFor` here. Disjoint from the others by `event`.
     */
    if (isDecisionTimeout(body)) {
      const outcome = deps.handleDecisionTimeout
        ? await deps.handleDecisionTimeout(body)
        : await handleDecisionTimeout(body, deps);
      log.info("decision timeout handled", { event: body.event, decisionId: body.decisionId, status: outcome.status });
      return c.json({ ok: true, status: outcome.status }, 200);
    }

    if (!isGatePending(body)) {
      // Another event superpipeline pushes — work.available, gate.resolved — or a
      // shape this build does not know. 200, because it was delivered fine and
      // a non-2xx would make the board retry something it will never like.
      return c.json({ ok: true, ignored: true }, 200);
    }

    const tenantId = await deps.tenantIdFor(body.boardId);
    if (!tenantId) {
      log.warn("push for a board mapped to no fleet", { boardId: body.boardId });
      return c.json({ error: "unknown board" }, 404);
    }

    const outcome = await projectGate(tenantId, body, deps);
    log.info("gate projected", { gateId: body.gateId, status: outcome.status });
    return c.json({ ok: true, status: outcome.status }, 200);
  });
}
