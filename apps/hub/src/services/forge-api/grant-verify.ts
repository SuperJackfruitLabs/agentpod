/**
 * Verifying a grant: what each verify answer does to the row (`settleVerify`), and the
 * `verifyGrant` operation, which re-sends an unacknowledged blob first.
 */
import type { ForgeTokenHandle } from "../../db/schema/forge-api-grants";
import { ForgeApiGrantError } from "./errors";
import { withGrantClaim } from "./grant-claim";
import { bareHandle, blobIsLive, compensateRevoke, loadGrant, loadStation, revokeTolerant, scrub } from "./grant-common";
import { sendDeliver } from "./grant-deliver";
import { log } from "./grant-log";
import { restorePrevious, rotationOf, sendRotationBlob } from "./grant-rotation-state";
import { transition } from "./grant-transition";
import { toRef, type ForgeApiDeps, type Grant, type Ref } from "./grant-types";
import { NEW_TOKEN_BAD, askVerify, isCoverageNote, type VerifyAnswer } from "./grant-verify-answer";

export interface VerifyResult {
  /** rotation-failed: an interrupted or refused rotation was undone; the previous token is current again. */
  /** unbrokered: identity matched but the node could not show the broker carries the traffic. */
  outcome: "verified" | "failed" | "node-offline" | "provider-unavailable" | "inconclusive" | "rotation-failed" | "unbrokered";
  grant: Grant;
}

function assertVerifiable(row: Grant): void {
  const ok =
    row.state === "delivered" ||
    row.state === "verified" ||
    // A failed grant the node may still hold: minted with a handle, or supplied/app once delivered.
    (row.state === "failed" && (row.mode === "minted" ? row.tokenHandle !== null : row.deliveredAt !== null));
  if (!ok) {
    throw new ForgeApiGrantError("grant-not-verifiable", `forge grant ${row.id} is ${row.state}; nothing to verify.`, row.id);
  }
}

/**
 * Apply a verify answer to the row (claim held).
 * - Match: `verified`; a `previous` is revoked (404 ok) and cleared — but during a rotation ONLY
 *   once the node acked the new token (before that a match may be n answering), else it is kept.
 * - Definitive failure after a rotation's ack: n is superseded (the node replaced it) so it is
 *   revoked now, best effort, else kept with disposition `revoke`; `unauthorized`/`wrong-identity`
 *   also revoke the NEW token (it is bad); `forbidden`/`repository-missing`/`redirect`/
 *   `unsupported` (configuration) do not. Grant `failed`, reason `rotation-failed`.
 * - Any other failure: `failed`, `previous` untouched. Offline/provider-down/inconclusive: unchanged.
 */
export async function settleVerify(deps: ForgeApiDeps, row: Grant, answer: VerifyAnswer): Promise<VerifyResult> {
  const handle = row.tokenHandle;
  const rot: Rotation = { handle, prev: handle?.previous, ...rotationOf(row) };
  switch (answer.kind) {
    case "offline":
      log.info("forge grant verify deferred: node unreachable", { grantId: row.id });
      return { outcome: "node-offline", grant: row };
    case "provider-unavailable":
    case "inconclusive": {
      log.info("forge grant verify inconclusive", { grantId: row.id, reason: answer.reason });
      // A coverage note (not-wired) only where it cannot clobber a lifecycle reason; state kept.
      if (answer.kind === "inconclusive" && answer.note && isCoverageNote(row.stateReason) && row.state !== "revoked") {
        const grant = await transition(deps.db, row, [row.state], row.state, { now: deps.now(), stateReason: answer.note });
        return { outcome: answer.kind, grant };
      }
      return { outcome: answer.kind, grant: row };
    }
    case "unbrokered":
      return settleUnbrokered(deps, row, answer, rot);
    case "failed":
      return settleFailed(deps, row, answer, rot);
    case "ok":
      return settleOk(deps, row, answer, rot);
  }
}

/** The row's token handle and rotation, as `settleVerify` read them before acting on an answer. */
interface Rotation {
  handle: ForgeTokenHandle | null;
  prev: ForgeTokenHandle["previous"];
  rotating: boolean;
  acked: boolean;
}

async function settleUnbrokered(
  deps: ForgeApiDeps,
  row: Grant,
  answer: Extract<VerifyAnswer, { kind: "unbrokered" }>,
  { handle, prev, rotating, acked }: Rotation,
): Promise<VerifyResult> {
  // Not verified: the broker was not shown to carry the traffic. A rotation is left as it is
  // (its lifecycle reason is not overwritten); otherwise the grant is `delivered`, a verified
  // one included — `verified` claims the broker is in the path.
  log.warn("forge grant not verified: traffic not shown to go through the broker", { grantId: row.id, reason: answer.reason });
  // The TOKEN lifecycle does not depend on harness wiring: the identity matched, so an acked
  // rotation settles its swap (previous revoked per its disposition) exactly as a verified one
  // would; only the grant's coverage claim stays `delivered`. Unacked: the match may be n.
  if (rotating && !acked) return { outcome: "unbrokered", grant: row };
  if (!["delivered", "verified", "failed"].includes(row.state)) return { outcome: "unbrokered", grant: row };
  let grant = await transition(deps.db, row, [row.state], "delivered", {
    now: deps.now(),
    verifiedAt: null,
    isolation: answer.isolation,
    stateReason: answer.reason,
  });
  if (rotating && handle && prev) {
    const { previous: _p, ...rest } = handle;
    try {
      await revokeTolerant(deps.providers(row.provider), row.account, bareHandle(prev));
      grant = await transition(deps.db, grant, ["delivered"], "delivered", { now: deps.now(), tokenHandle: rest, stateReason: answer.reason });
    } catch (err) {
      grant = await transition(deps.db, grant, ["delivered"], "delivered", {
        now: deps.now(),
        tokenHandle: { ...rest, previous: { ...prev, disposition: "revoke" } },
        stateReason: `previous-revoke-pending: ${scrub(err)}`,
      });
    }
  }
  return { outcome: "unbrokered", grant };
}

async function settleFailed(
  deps: ForgeApiDeps,
  row: Grant,
  answer: Extract<VerifyAnswer, { kind: "failed" }>,
  { handle, prev, acked }: Rotation,
): Promise<VerifyResult> {
  if (acked && handle && prev) {
    const provider = deps.providers(row.provider);
    const { previous: _p, ...current } = handle;
    if (NEW_TOKEN_BAD.has(answer.code)) await compensateRevoke(provider, row.account, bareHandle(current), row.id);
    const nGone = await compensateRevoke(provider, row.account, bareHandle(prev), row.id);
    const reason = `rotation-failed: ${answer.reason}`;
    const grant = await transition(deps.db, row, [row.state], "failed", {
      now: deps.now(),
      tokenHandle: nGone ? current : { ...current, previous: { ...prev, disposition: "revoke" } },
      stateReason: reason,
    });
    log.warn("forge grant rotation failed after delivery", { grantId: row.id, reason });
    return { outcome: "failed", grant };
  }
  log.warn("forge grant failed verification", { grantId: row.id, reason: answer.reason });
  const grant = await transition(deps.db, row, [row.state], "failed", { now: deps.now(), stateReason: answer.reason });
  return { outcome: "failed", grant };
}

async function settleOk(
  deps: ForgeApiDeps,
  row: Grant,
  answer: Extract<VerifyAnswer, { kind: "ok" }>,
  { handle, prev, rotating, acked }: Rotation,
): Promise<VerifyResult> {
  const now = deps.now();
  const revokePrev = !!prev && (!rotating || acked);
  let grant = await transition(deps.db, row, [row.state], "verified", {
    now,
    verifiedAt: now,
    isolation: answer.isolation,
    stateReason: revokePrev
      ? `verified; revoking ${prev.name}`
      : rotating
        ? "rotation-pending: new token not acknowledged"
        : (answer.note ?? null),
  });
  if (revokePrev && handle) {
    const { previous: _p, ...rest } = handle;
    try {
      await revokeTolerant(deps.providers(row.provider), row.account, bareHandle(prev));
      grant = await transition(deps.db, grant, ["verified"], "verified", { now: deps.now(), tokenHandle: rest, stateReason: answer.note ?? null });
    } catch (err) {
      log.warn("forge grant verified but the previous token is not revoked yet", { grantId: row.id });
      grant = await transition(deps.db, grant, ["verified"], "verified", {
        now: deps.now(),
        tokenHandle: { ...rest, previous: { ...prev, disposition: "revoke" } },
        stateReason: `previous-revoke-pending: ${scrub(err)}`,
      });
    }
  }
  log.info("forge grant verified", { grantId: row.id });
  return { outcome: "verified", grant };
}

/**
 * `forge.api.verify` with the provider's expected identity; see `askVerify` for the reason mapping
 * and `settleVerify` for what each answer does. A live unacknowledged blob is re-sent first (a
 * rotation's through `sendRotationBlob`). A rotation interrupted before its blob existed (the new
 * token was never sealed, so it can never reach the node) is undone: `rotation-failed`.
 */
export async function verifyGrant(deps: ForgeApiDeps, ref: Ref): Promise<VerifyResult> {
  const stale = await loadGrant(deps.db, toRef(ref));
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    let row = await loadGrant(deps.db, stale);
    assertVerifiable(row);
    if (!row.stationId) {
      throw new ForgeApiGrantError("grant-not-verifiable", `forge grant ${row.id}'s station is gone.`, row.id);
    }
    const station = await loadStation(deps.db, row.tenantId, row.stationId);
    const { rotating } = rotationOf(row);
    if (row.sealedBlob) {
      // The node has not acknowledged the current credential; verifying now could pass on the old.
      if (!blobIsLive(row, deps.now())) {
        throw new ForgeApiGrantError(
          "grant-not-verifiable",
          `forge grant ${row.id}: its current credential was never acknowledged and the sealed copy expired.`,
          row.id,
        );
      }
      row = rotating ? await sendRotationBlob(deps, row, station) : await sendDeliver(deps, row, station, row.sealedBlob);
      if (rotating && !row.tokenHandle?.previous) return { outcome: "rotation-failed", grant: row };
      if (row.sealedBlob) return { outcome: row.state === "failed" ? "failed" : "node-offline", grant: row };
    } else if (rotating && row.deliveredAt === null) {
      // Interrupted between mint and seal: no blob was ever made, so the new token cannot be
      // delivered and the node still holds n. Undo the rotation; n stays.
      const restored = await restorePrevious(deps, row, "interrupted before the new token was sealed");
      return { outcome: "rotation-failed", grant: restored };
    }
    return settleVerify(deps, row, await askVerify(deps, row, station));
  });
}
