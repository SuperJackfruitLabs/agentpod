/**
 * Resolving a gate at superpipeline as the human, with a short-lived assertion.
 *
 * Split out of `gates.ts`, which re-exports it.
 */

import { createLogger } from "../../utils/logger";
import { assertionFailureCode, type AssertionSubject } from "../../auth/org-plane/assertion";
import type { GateOptionId } from "./gate-wire";

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
    decision: GateOptionId;
    comment: string | null;
    principalId: string;
    senderMxid: string;
  },
  deps: {
    baseUrl: string;
    mint(subject: AssertionSubject): Promise<string>;
    fetch?: typeof fetch;
  }
): Promise<{ ok: true } | { ok: false; code: string }> {
  let token: string;
  try {
    token = await deps.mint({ principalId: input.principalId, senderMxid: input.senderMxid });
  } catch (err) {
    // Under the org plane the assertion is the plane's to give (contract §3.4b). Refused or
    // unreachable is a failed outcome the caller reports, never a token-less call to the board.
    // Anything else throws, as it always has.
    const code = assertionFailureCode(err);
    if (!code) throw err;
    log.warn("no assertion for a gate decision", {
      gateId: input.gateId,
      code,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code };
  }
  const doFetch = deps.fetch ?? fetch;
  const base = deps.baseUrl.replace(/\/+$/, "");

  let res: Response;
  try {
    res = await doFetch(
      `${base}/v1/boards/${encodeURIComponent(input.boardId)}/gates/${encodeURIComponent(input.gateId)}/resolve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          decision: input.decision,
          ...(input.comment ? { comment: input.comment } : {}),
        }),
      }
    );
  } catch (err) {
    // The network, not a refusal. Distinguished because a refusal is final and
    // this is not — the reader should be able to press the button again.
    log.warn("gate resolution did not reach the board", {
      gateId: input.gateId,
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
    const body = (await res.json()) as { error?: { code?: string } };
    if (body.error?.code) code = body.error.code;
  } catch {
    // Keep the status-derived code.
  }
  return { ok: false, code };
}
