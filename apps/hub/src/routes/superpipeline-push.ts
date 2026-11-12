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

import { Hono, type Context } from "hono";

import { createLogger } from "../utils/logger";
import { isGatePending, projectGate, type GatePendingDelivery, type GateProjectionDeps } from "../services/board-chat";
import { isElicitationPending } from "../services/board-chat";
import { isBoardMoved } from "../services/board-chat";
import { isApprovalRequest } from "@superjackfruitlabs/treaty-matrix-events";
import { projectElicitation } from "../services/board-chat";
import { projectDelivery } from "../services/board-chat";
import { isDeliveryPending } from "@superjackfruitlabs/treaty-matrix-events";
import { projectAttention } from "../services/board-chat";
import { isAttentionPending } from "@superjackfruitlabs/treaty-matrix-events";
import type { AttentionProjectionDeps } from "../services/board-chat";
import { handleDecisionTimeout } from "../services/board-chat";
import { isDecisionTimeout } from "@superjackfruitlabs/treaty-matrix-events";
import type { DecisionNoticeDeps, DecisionNoticeOutcome } from "../services/board-chat";
import { handleGateApprovalRecorded } from "../services/board-chat";
import { isGateApprovalRecorded } from "@superjackfruitlabs/treaty-matrix-events";
import type { GateProgressOutcome } from "../services/board-chat";
import { handleDecisionPulledBack, handleDecisionReleased } from "../services/board-chat";
import { isDecisionPulledBack, isDecisionReleased } from "@superjackfruitlabs/treaty-matrix-events";
import type { GateHoldOutcome } from "../services/board-chat";
import { handleCheckFailed, handleCheckOverridden } from "../services/board-chat";
import { isCheckFailed, isCheckOverridden } from "@superjackfruitlabs/treaty-matrix-events";
import type { CheckNoticeOutcome } from "../services/board-chat";
import type {
  CheckFailedDelivery,
  CheckOverriddenDelivery,
  DecisionPulledBackDelivery,
  DecisionReleasedDelivery,
  DecisionTimeoutDelivery,
  GateApprovalRecordedDelivery,
} from "../services/bridge";
import { isWorkAvailable, wakeBoard } from "../services/bridge";

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
  /** A card's checks as the board reads them, listed when overdue checks escalate (`boardProjectionDeps`). */
  checksForCard?: DecisionNoticeDeps["checksForCard"];
  /** Test seam: what a reminder or escalation does. Defaults to `handleDecisionTimeout`. */
  handleDecisionTimeout?(d: DecisionTimeoutDelivery): Promise<DecisionNoticeOutcome>;
  /** How to name an approver in a quorum gate's progress reply: their handle, never an mxid. */
  displayNameFor?(principalId: string): Promise<string | null>;
  /** Test seam: what a quorum gate's recorded approval does. Defaults to `handleGateApprovalRecorded`. */
  handleGateApprovalRecorded?(d: GateApprovalRecordedDelivery): Promise<GateProgressOutcome>;
  /** Test seam: what a held approval's release does. Defaults to `handleDecisionReleased`. */
  handleDecisionReleased?(d: DecisionReleasedDelivery): Promise<GateHoldOutcome>;
  /** Test seam: what a held approval's pull-back does. Defaults to `handleDecisionPulledBack`. */
  handleDecisionPulledBack?(d: DecisionPulledBackDelivery): Promise<GateHoldOutcome>;
  /** Test seam: what a failed check does. Defaults to `handleCheckFailed`. */
  handleCheckFailed?(d: CheckFailedDelivery): Promise<CheckNoticeOutcome>;
  /** Test seam: what an overridden check does. Defaults to `handleCheckOverridden`. */
  handleCheckOverridden?(d: CheckOverriddenDelivery): Promise<CheckNoticeOutcome>;
  /** Test seam: wake a board's claim loops on `work.available`. Defaults to the bridge's `wakeBoard`. */
  wakeBoard?(boardId: string): number;
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

/**
 * A signed delivery's parsed body, or the refusal to send instead. Fails closed with no secret;
 * reads the bytes once, verifies those, and only then parses them.
 */
async function signedBody(secret: string | undefined, c: Context): Promise<{ body: unknown } | { refusal: Response }> {
  if (!secret) {
    log.warn("push rejected: no signing secret configured");
    return { refusal: c.json({ error: "not configured" }, 503) };
  }
  const signature = c.req.header("X-Superpipeline-Signature");
  if (!signature) return { refusal: c.json({ error: "unsigned" }, 401) };
  const raw = await c.req.text();
  if (!(await signatureMatches(secret, raw, signature))) {
    log.warn("push rejected: bad signature", { bytes: raw.length });
    return { refusal: c.json({ error: "bad signature" }, 401) };
  }
  try {
    return { body: JSON.parse(raw) };
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
    const signed = await signedBody(deps.secret, c);
    if ("refusal" in signed) return signed.refusal;
    if (!isWorkAvailable(signed.body)) return c.json({ ok: true, ignored: true }, 200);
    const boardId = signed.body.boardId;
    const woken = deps.wakeBoard ? deps.wakeBoard(boardId) : wakeBoard(boardId);
    log.info("work available; claim loops woken", { boardId: signed.body.boardId, woken });
    return c.json({ ok: true, woken }, 200);
  })
  .post("/bridge/superpipeline/push", async (c) => {
    const signed = await signedBody(deps.secret, c);
    if ("refusal" in signed) return signed.refusal;
    const body = signed.body;

    // A board whose chat has moved out of this hub (`moved-boards.ts`): nothing it pushes is posted
    // here. 200, so the board does not retry what this hub will never post.
    const boardId = typeof body === "object" && body !== null && "boardId" in body ? body.boardId : undefined;
    if (typeof boardId === "string" && isBoardMoved(boardId)) {
      log.info("push for a board whose chat has moved; not posted", { boardId });
      return c.json({ ok: true, status: "moved" }, 200);
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

    /**
     * An approval on a quorum gate short of its quorum (charter: "A gate may need more than one
     * approver" §7): a progress reply to the gate card this hub posted. The board picks its tenant
     * by the reminder's rule (one tenant or nobody, `gate-progress.ts`), so no `tenantIdFor` here.
     * Disjoint from the others by `event`.
     */
    if (isGateApprovalRecorded(body)) {
      const outcome = deps.handleGateApprovalRecorded
        ? await deps.handleGateApprovalRecorded(body)
        : await handleGateApprovalRecorded(body, deps);
      log.info("quorum gate approval handled", { gateId: body.gateId, status: outcome.status });
      return c.json({ ok: true, status: outcome.status }, 200);
    }

    /**
     * A held approval released at its release time, or pulled back before it (charter: "An approval
     * may wait for its release time" §7): a reply to the gate card this hub posted. One tenant or
     * nobody, as for progress (`gate-hold.ts`). Disjoint from the others by `event`.
     */
    if (isDecisionReleased(body)) {
      const outcome = deps.handleDecisionReleased
        ? await deps.handleDecisionReleased(body)
        : await handleDecisionReleased(body, deps);
      log.info("held approval release handled", { gateId: body.gateId, outcome: body.outcome, status: outcome.status });
      return c.json({ ok: true, status: outcome.status }, 200);
    }
    if (isDecisionPulledBack(body)) {
      const outcome = deps.handleDecisionPulledBack
        ? await deps.handleDecisionPulledBack(body)
        : await handleDecisionPulledBack(body, deps);
      log.info("held approval pull-back handled", { gateId: body.gateId, status: outcome.status });
      return c.json({ ok: true, status: outcome.status }, 200);
    }

    /**
     * A machine check failed and returned the card, or was overridden (charter: "A gate may be decided
     * by checks" §7): a line in the board's room. One tenant or nobody, as for a reminder
     * (`check-notices.ts`). Disjoint from the others by `event`.
     */
    if (isCheckFailed(body)) {
      const outcome = deps.handleCheckFailed ? await deps.handleCheckFailed(body) : await handleCheckFailed(body, deps);
      log.info("failed check handled", { boardId: body.boardId, cardId: body.cardId, check: body.check.name, status: outcome.status });
      return c.json({ ok: true, status: outcome.status }, 200);
    }
    if (isCheckOverridden(body)) {
      const outcome = deps.handleCheckOverridden ? await deps.handleCheckOverridden(body) : await handleCheckOverridden(body, deps);
      log.info("overridden check handled", { boardId: body.boardId, cardId: body.cardId, check: body.check.name, status: outcome.status });
      return c.json({ ok: true, status: outcome.status }, 200);
    }

    if (!isGatePending(body)) {
      // Another event superpipeline pushes — work.available, gate.resolved — or a
      // shape this build does not know. 200, because it was delivered fine and
      // a non-2xx would make the board retry something it will never like.
      return c.json({ ok: true, ignored: true }, 200);
    }

    const result = await projectPushedGate(body, deps, "push");
    return c.json(result.body, result.status);
  });
}

/**
 * A pushed gate into its board's room: the one place both doors (the board's direct push, and the
 * event relay since treaty plan step 7) hand a `gate.pending` to `projectGate`. Idempotent on the
 * gate id, so the two doors may both deliver the same gate. `via` names the door in the log, which
 * is how a staging proof tells them apart.
 */
export async function projectPushedGate(
  body: GatePendingDelivery,
  deps: Pick<SuperpipelinePushDeps, "tenantIdFor"> & GateProjectionDeps,
  via: "push" | "event-relay",
): Promise<{ status: 200 | 404; body: Record<string, unknown> }> {
  const tenantId = await deps.tenantIdFor(body.boardId);
  if (!tenantId) {
    log.warn("gate for a board mapped to no fleet", { boardId: body.boardId, via });
    return { status: 404, body: { error: "unknown board" } };
  }
  const outcome = await projectGate(tenantId, body, deps);
  log.info("gate projected", { gateId: body.gateId, status: outcome.status, via });
  return { status: 200, body: { ok: true, status: outcome.status } };
}
