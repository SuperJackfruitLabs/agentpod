/**
 * Minted rotation, step by step under the grant's claim: `previous` persisted before anything is
 * minted, then mint → hub-side check → seal → deliver → node verify, each pre-ack failure undone.
 * Also the undo of a rotation whose sealed copy expired unacknowledged.
 */
import type { ForgeTokenHandle, ForgeTokenRef } from "../../db/schema/forge-api-grants";
import { ForgeApiGrantError } from "./errors";
import { tokenName } from "./forgejo";
import { nextGeneration } from "./generation";
import { withGrantClaim } from "./grant-claim";
import { bareHandle, blobIsLive, expectLoginFor, grantRef, loadGrant, loadStation, scrub, untrusted } from "./grant-common";
import { log } from "./grant-log";
import { stationPublicKey } from "./grant-node";
import { VERIFY_PENDING } from "./grant-revoke-state";
import { restorePrevious, rotationOf, sendRotationBlob } from "./grant-rotation-state";
import { transition } from "./grant-transition";
import { SEALED_BLOB_TTL_MS, toRef, type ForgeApiDeps, type Grant, type Ref, type StationRow } from "./grant-types";
import { askVerify } from "./grant-verify-answer";
import { settleVerify } from "./grant-verify";
import { splitRepo, type ForgeProvider } from "./providers";

// ─── rotate (minted) ──────────────────────────────────────────────────────────

/**
 * Minted rotation; see station-forge-api.ts's header for every outcome. Supplied and app grants rotate by the
 * operator supplying a new sealed credential (`acceptSuppliedSecret`).
 *
 * Returns the row: `verified` when finished, or `rotation-pending` (delivered or unchanged state)
 * when the node may hold the new token but has not verified it. Throws `rotation-failed` when the
 * rotation was taken back (pre-ack) or the new token was definitively the wrong identity. An
 * unreachable node is found before any mint (`station-key-unavailable`), changing nothing.
 */
export async function rotateGrant(deps: ForgeApiDeps, ref: Ref): Promise<Grant> {
  const stale = await loadGrant(deps.db, toRef(ref));
  if (stale.mode !== "minted") {
    throw new ForgeApiGrantError(
      "mode-not-supported",
      `forge grant ${stale.id} is ${stale.mode}: rotate it by supplying a new sealed credential.`,
      stale.id,
    );
  }
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    const row = await loadGrant(deps.db, stale);
    if ((row.state !== "delivered" && row.state !== "verified") || !row.tokenHandle) {
      throw new ForgeApiGrantError("grant-not-rotatable", `forge grant ${row.id} is ${row.state}; only a delivered grant rotates.`, row.id);
    }
    if (row.tokenHandle.previous || row.tokenHandle.orphan || row.sealedBlob) {
      throw new ForgeApiGrantError(
        "grant-not-rotatable",
        `forge grant ${row.id} has an unfinished rotation or a token to revoke; finish that first.`,
        row.id,
      );
    }
    if (!row.stationId) {
      throw new ForgeApiGrantError("grant-not-rotatable", `forge grant ${row.id}'s station is gone.`, row.id);
    }
    const station = await loadStation(deps.db, row.tenantId, row.stationId);
    const provider = deps.providers(row.provider);
    if (!provider.mint) throw new ForgeApiGrantError("mode-not-supported", `forge: ${provider.kind} cannot mint tokens.`, row.id);
    // Before any mint: proves the node is reachable and gives the key to seal to.
    const publicKey = await stationPublicKey(deps, station);
    return rotateClaimed(deps, row, station, provider, publicKey);
  });
}


type PriorState = "delivered" | "verified";
type Previous = NonNullable<ForgeTokenHandle["previous"]>;

async function rotateClaimed(
  deps: ForgeApiDeps,
  before: Grant,
  station: StationRow,
  provider: ForgeProvider,
  publicKey: string,
): Promise<Grant> {
  const priorState = before.state as PriorState;
  const { row: started, previous } = await startRotation(deps, before, priorState);
  const minted = await mintNext(deps, started, provider, previous, priorState);
  const sealed = await sealNext(deps, minted.row, provider, publicKey, priorState, minted.newHandle, minted.secret);
  return deliverAndVerify(deps, sealed, station);
}

/** PRE-ACK: the node never took the new token. Undo, then report. */
async function abortPreAck(deps: ForgeApiDeps, row: Grant, why: string, current: ForgeTokenRef, secret?: string): Promise<never> {
  await restorePrevious(deps, row, why, current, secret);
  throw new ForgeApiGrantError("rotation-failed", `forge grant ${row.id}: rotation-failed: ${why}`, row.id);
}

/**
 * 1. BEFORE minting: `previous`, the next generation's deterministic name, and delivered_at
 *    cleared (it is set again only by the node's ack of the new token).
 */
async function startRotation(deps: ForgeApiDeps, before: Grant, priorState: PriorState): Promise<{ row: Grant; previous: Previous }> {
  const oldHandle = bareHandle(before.tokenHandle!);
  // Everything needed to put n back, kept in the jsonb so a crash loses none of it.
  const previous: Previous = {
    ...oldHandle,
    disposition: "live-until-verified" as const,
    generation: before.generation,
    deliveredAt: before.deliveredAt ? before.deliveredAt.toISOString() : null,
  };
  const row = await deps.db.transaction(async (tx) => {
    const generation = await nextGeneration(tx, before.tenantId, before.stationIdSnapshot, before.provider, before.instance);
    return transition(tx, before, [priorState], priorState, {
      now: deps.now(),
      generation,
      deliveredAt: null,
      tokenHandle: { name: tokenName({ id: before.id, generation }), previous },
      stateReason: `rotation-pending: minting generation ${generation}`,
    });
  });
  return { row, previous };
}

/** 2. Mint generation n+1 and record its handle. The token lives in `secret` until it is sealed. */
async function mintNext(
  deps: ForgeApiDeps,
  started: Grant,
  provider: ForgeProvider,
  previous: Previous,
  priorState: PriorState,
): Promise<{ row: Grant; newHandle: ForgeTokenRef; secret: string }> {
  let row = started;
  const newName = row.tokenHandle!.name;
  let minted: { id: number | undefined; name: string; secret: string };
  try {
    minted = await provider.mint!(row.account, {
      name: newName,
      scopes: provider.mintScopes(grantRef(row)),
      repositories: row.repositories.map(splitRepo),
    });
  } catch (err) {
    return abortPreAck(deps, row, `mint failed: ${scrub(err)}`, { name: newName });
  }
  let secret: string | undefined = minted.secret;
  const newHandle: ForgeTokenRef = minted.id === undefined ? { name: minted.name } : { id: minted.id, name: minted.name };
  try {
    row = await transition(deps.db, row, [priorState], priorState, {
      now: deps.now(),
      tokenHandle: { ...newHandle, previous },
      stateReason: row.stateReason,
    });
  } catch (err) {
    const s = secret;
    secret = undefined;
    return abortPreAck(deps, row, `the new token could not be recorded (${scrub(err, s)})`, newHandle, s);
  }
  return { row, newHandle, secret };
}

/**
 * 3. Hub-side check: the forge must say the new token is the expected account.
 * 4. Seal, and persist the blob in the UPDATE that follows sealing, BEFORE the frame goes out:
 *    from the moment n+1 can reach the node, "live blob" means "not acknowledged".
 */
async function sealNext(
  deps: ForgeApiDeps,
  recorded: Grant,
  provider: ForgeProvider,
  publicKey: string,
  priorState: PriorState,
  newHandle: ForgeTokenRef,
  token: string,
): Promise<Grant> {
  let row = recorded;
  let secret: string | undefined = token;
  if (provider.checkToken) {
    let login: string;
    try {
      ({ login } = await provider.checkToken(row.account, secret));
    } catch (err) {
      const s = secret;
      secret = undefined;
      return abortPreAck(deps, row, `the new token did not check out: ${scrub(err, s)}`, newHandle, s);
    }
    const expected = expectLoginFor(deps, row);
    if (login.toLowerCase() !== expected.toLowerCase()) {
      secret = undefined;
      return abortPreAck(deps, row, `the new token belongs to ${untrusted(login)}, not ${expected}`, newHandle);
    }
  }

  let sealed: string;
  try {
    sealed = await deps.seal(publicKey, { token: secret });
  } catch (err) {
    const why = `seal failed: ${scrub(err, secret)}`;
    secret = undefined;
    return abortPreAck(deps, row, why, newHandle);
  }
  secret = undefined;
  try {
    const now = deps.now();
    row = await transition(deps.db, row, [priorState], priorState, {
      now,
      sealed: { blob: sealed, expiresAt: new Date(now.getTime() + SEALED_BLOB_TTL_MS) },
      stateReason: "rotation-pending: delivering",
    });
  } catch (err) {
    return abortPreAck(deps, row, `the sealed token could not be recorded (${scrub(err)})`, newHandle);
  }
  return row;
}

/**
 * 5. Deliver. Refused → undone (pre-ack); transient/unreadable → ambiguous, left pending.
 * 6. POST-ACK: verify the new token on the node.
 */
async function deliverAndVerify(deps: ForgeApiDeps, sealed: Grant, station: StationRow): Promise<Grant> {
  const row = await sendRotationBlob(deps, sealed, station);
  if (!row.tokenHandle?.previous) {
    throw new ForgeApiGrantError("rotation-failed", `forge grant ${row.id}: ${row.stateReason}`, row.id);
  }
  if (row.sealedBlob) return row;

  const settled = await settleVerify(deps, row, await askVerify(deps, row, station));
  if (settled.outcome === "failed" && settled.grant.stateReason?.startsWith("rotation-failed")) {
    throw new ForgeApiGrantError("rotation-failed", `forge grant ${row.id}: ${settled.grant.stateReason}`, row.id);
  }
  if (settled.outcome === "verified") {
    log.info("forge grant rotated", { grantId: row.id, stationId: station.id, generation: settled.grant.generation });
    return settled.grant;
  }
  if (settled.outcome === "failed") return settled.grant;
  // Swap settled (or, unacked, left for verifyGrant): either way the row already says why.
  if (settled.outcome === "unbrokered" && !rotationOf(settled.grant).rotating) return settled.grant;
  // Unverified for now: keep `rotation-pending` (plus why) so verifyGrant finishes it.
  return transition(deps.db, settled.grant, ["delivered"], "delivered", {
    now: deps.now(),
    stateReason: `rotation-pending: ${settled.outcome}`,
  });
}

/**
 * Undo a rotation whose new token's sealed blob expired unacknowledged: the hub cannot re-seal it,
 * so generation n+1 is revoked and the row returns to n (`restorePrevious`, the same undo the
 * pre-ack failures use). Returns the row unchanged when it is not such a rotation.
 */
export async function undoExpiredRotation(deps: ForgeApiDeps, ref: Ref): Promise<Grant> {
  const stale = await loadGrant(deps.db, toRef(ref));
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    const row = await loadGrant(deps.db, stale);
    const { rotating } = rotationOf(row);
    if (!rotating || !row.sealedBlob || blobIsLive(row, deps.now())) return row;
    const restored = await restorePrevious(deps, row, "the new token's sealed copy expired unacknowledged");
    // The frame may have reached the node (an ambiguous delivery), so the node may now hold the
    // revoked n+1 instead of n. Verify once on the next sweep: a match clears the marker, a
    // failure (wrong-identity, unauthorized) fails the grant honestly.
    return transition(deps.db, restored, [restored.state], restored.state, {
      now: deps.now(),
      stateReason: `${restored.stateReason}; ${VERIFY_PENDING}`,
    });
  });
}
