/**
 * Resolving a gate at superpipeline as the human, with a short-lived assertion.
 *
 * Split out of `gates.ts`, which re-exports it.
 */

import { createLogger } from "../../utils/logger";
import { assertionFailureCode, type AssertionSubject } from "../../auth/org-plane/assertion";

const log = createLogger("matrix-gates");

/**
 * Resolve a gate at superpipeline **as the human**, using a short-lived assertion.
 *
 * This is the function `charter →
 * decisions/2026-08-14-approvals-cross-planes-as-events.md` is about. The
 * alternative — calling with this service's own `spa_` agent token — would work
 * on the first try and make every approval in the suite attribute to one
 * account, voiding superpipeline's separation-of-duties check while appearing to
 * succeed. That is why the token is minted per decision rather than held.
 *
 * `principalId` must have come from `principal_identities`. See
 * `mintPrincipalAssertion`, which says the same thing louder.
 */
export async function resolveGateAtSuperpipeline(
  input: {
    boardId: string;
    gateId: string;
    /** The option id the person chose. Not checked against a list: superpipeline judges it. */
    decision: string;
    comment: string | null;
    principalId: string;
    senderMxid: string;
    /** gate.v2: the subject the person was shown, sent so superpipeline can bind to it. */
    approvalSubject?: { id: string; digest: string };
  },
  deps: BoardCallDeps
): Promise<{ ok: true } | { ok: false; code: string }> {
  return postToBoardAsPrincipal(
    `/v1/boards/${encodeURIComponent(input.boardId)}/gates/${encodeURIComponent(input.gateId)}/resolve`,
    {
      decision: input.decision,
      ...(input.comment ? { comment: input.comment } : {}),
      ...(input.approvalSubject
        ? {
            approvalSubjectId: input.approvalSubject.id,
            approvalSubjectDigest: input.approvalSubject.digest,
          }
        : {}),
    },
    input,
    deps,
  );
}

/**
 * Pull a held approval back at superpipeline before its release time — **as the person who sent
 * the pull-back** (charter: "An approval may wait for its release time" §4). A person-only route,
 * judged like a decision on the gate, so the same per-answer assertion as `resolveGateAtSuperpipeline`.
 */
export async function pullBackAtSuperpipeline(
  input: { boardId: string; gateId: string; comment: string; principalId: string; senderMxid: string },
  deps: BoardCallDeps,
): Promise<{ ok: true } | { ok: false; code: string }> {
  return postToBoardAsPrincipal(
    `/v1/boards/${encodeURIComponent(input.boardId)}/gates/${encodeURIComponent(input.gateId)}/pull-back`,
    { comment: input.comment },
    input,
    deps,
  );
}

/**
 * Record a manual delivery's live link, or switch it to automatic delivery, at superpipeline —
 * **as the human who answered the follow-up** (charter: "The decision envelope covers questions
 * and follow-ups" §3). The same assertion, minted per answer, for the reason
 * `resolveGateAtSuperpipeline` gives: the board's delivery route checks who decided the gate, and
 * an answer carried as this service would attribute to nobody who saw it.
 */
export async function updateDeliveryAtSuperpipeline(
  input: {
    boardId: string;
    gateId: string;
    change: { liveUrl: string } | { mode: "automatic" };
    principalId: string;
    senderMxid: string;
  },
  deps: BoardCallDeps,
): Promise<{ ok: true } | { ok: false; code: string }> {
  return postToBoardAsPrincipal(
    `/v1/boards/${encodeURIComponent(input.boardId)}/gates/${encodeURIComponent(input.gateId)}/delivery`,
    input.change,
    input,
    deps,
  );
}

/**
 * Resume a waiting card, or archive it, at superpipeline — **as the person who answered its
 * attention.v2** (charter: "Waiting cards and broker approvals reach chat" §2). Both are
 * person-only routes; the same per-answer assertion as a gate, for the same reason. The wait id
 * goes as `expectedWaitId`, so a late tap never acts on a different wait: the board refuses a stale
 * one `WAIT_CHANGED` and changes nothing.
 */
export async function answerAttentionAtSuperpipeline(
  input: {
    boardId: string;
    cardId: string;
    waitId: string;
    action: { kind: "resume"; toStageKey: string | null; comment: string } | { kind: "archive"; comment: string | null };
    principalId: string;
    senderMxid: string;
  },
  deps: BoardCallDeps,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const card = `/v1/boards/${encodeURIComponent(input.boardId)}/cards/${encodeURIComponent(input.cardId)}`;
  const a = input.action;
  if (a.kind === "resume") {
    return postToBoardAsPrincipal(
      `${card}/resume`,
      { comment: a.comment, ...(a.toStageKey !== null ? { toStageKey: a.toStageKey } : {}), expectedWaitId: input.waitId },
      { ...input, ref: input.waitId },
      deps,
    );
  }
  return postToBoardAsPrincipal(
    `${card}/archive`,
    { expectedWaitId: input.waitId, ...(a.comment !== null ? { comment: a.comment } : {}) },
    { ...input, ref: input.waitId },
    deps,
  );
}

interface BoardCallDeps {
  baseUrl: string;
  mint(subject: AssertionSubject): Promise<string>;
  fetch?: typeof fetch;
}

/** POST `body` to a board route with an assertion minted for the person, and read the outcome. */
async function postToBoardAsPrincipal(
  path: string,
  body: Record<string, unknown>,
  who: { gateId?: string; ref?: string; principalId: string; senderMxid: string },
  deps: BoardCallDeps,
): Promise<{ ok: true } | { ok: false; code: string }> {
  let token: string;
  try {
    token = await deps.mint({ principalId: who.principalId, senderMxid: who.senderMxid });
  } catch (err) {
    // Under the org plane the assertion is the plane's to give (contract §3.4b). Refused or
    // unreachable is a failed outcome the caller reports, never a token-less call to the board.
    // Anything else throws, as it always has.
    const code = assertionFailureCode(err);
    if (!code) throw err;
    log.warn("no assertion for a board call", {
      ref: who.ref ?? who.gateId,
      code,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code };
  }
  const doFetch = deps.fetch ?? fetch;
  const base = deps.baseUrl.replace(/\/+$/, "");

  let res: Response;
  try {
    res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // The network, not a refusal. Distinguished because a refusal is final and
    // this is not — the reader should be able to press the button again.
    log.warn("a board call did not reach the board", {
      ref: who.ref ?? who.gateId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNREACHABLE" };
  }

  if (res.ok) return { ok: true };

  // superpipeline answers with `{ error: { code } }`. The code is what matters:
  // it answers 403 for SEPARATION_OF_DUTIES and 409 for GATE_NOT_PENDING, and
  // those are different situations with the same shape.
  let code = `HTTP_${res.status}`;
  try {
    const parsed: unknown = await res.json();
    const found = errorCode(parsed);
    if (found) code = found;
  } catch {
    // Keep the status-derived code.
  }
  return { ok: false, code };
}

/** `{ error: { code } }`'s code, or null. */
function errorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const error = body.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" && error.code !== "" ? error.code : null;
}
