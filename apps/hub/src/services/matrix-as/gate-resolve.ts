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

interface BoardCallDeps {
  baseUrl: string;
  mint(subject: AssertionSubject): Promise<string>;
  fetch?: typeof fetch;
}

/** POST `body` to a board route with an assertion minted for the person, and read the outcome. */
async function postToBoardAsPrincipal(
  path: string,
  body: Record<string, unknown>,
  who: { gateId: string; principalId: string; senderMxid: string },
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
    log.warn("no assertion for a gate decision", {
      gateId: who.gateId,
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
    log.warn("gate resolution did not reach the board", {
      gateId: who.gateId,
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
