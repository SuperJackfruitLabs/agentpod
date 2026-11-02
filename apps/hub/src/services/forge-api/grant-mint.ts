/**
 * Minted mode: carry a grant forward under its claim. Re-send a live blob, or revoke an
 * undeliverable token and mint the next generation; `mintAndDeliver` is the only function that
 * ever holds a token.
 */
import { nextGeneration } from "./generation";
import { tokenName } from "./forgejo";
import { ForgeApiGrantError } from "./errors";
import { withGrantClaim } from "./grant-claim";
import {
  blobIsLive,
  compensateRevoke,
  grantRef,
  loadGrant,
  loadStation,
  needsOperatorCredential,
  revokeTolerant,
  scrub,
} from "./grant-common";
import { sendDeliver } from "./grant-deliver";
import { log } from "./grant-log";
import { stationPublicKey } from "./grant-node";
import { rotationOf, sendRotationBlob } from "./grant-rotation-state";
import { transition } from "./grant-transition";
import { SEALED_BLOB_TTL_MS, type ForgeApiDeps, type Grant, type StationRow } from "./grant-types";
import { splitRepo, type ForgeProvider } from "./providers";

// ─── deliverGrant ─────────────────────────────────────────────────────────────

/**
 * Carry a grant forward: re-send a live sealed blob without minting, or, when the blob has expired
 * or was never stored, revoke the old token and mint generation + 1. Delivered/verified grants are
 * returned unchanged; revoking/revoked ones are refused. Same return/throw contract as
 * `createForgeApiGrant`.
 */
export async function deliverGrant(deps: ForgeApiDeps, ref: { tenantId: string; grantId: string }): Promise<Grant> {
  const row = await loadGrant(deps.db, { tenantId: ref.tenantId, id: ref.grantId });
  // A delivered/verified grant is left alone unless it carries an unacknowledged live blob (an
  // ambiguous rotation delivery or a re-supplied credential): then that blob is re-sent.
  if ((row.state === "delivered" || row.state === "verified") && !blobIsLive(row, deps.now())) return row;
  if (row.state === "revoking" || row.state === "revoked") {
    throw new ForgeApiGrantError("grant-not-deliverable", `forge grant ${row.id} is ${row.state}.`, row.id);
  }
  if (!row.stationId) {
    throw new ForgeApiGrantError("grant-not-deliverable", `forge grant ${row.id}'s station is gone.`, row.id);
  }
  const station = await loadStation(deps.db, row.tenantId, row.stationId);
  const provider = deps.providers(row.provider);
  const blobLive = blobIsLive(row, deps.now());
  if (!blobLive && row.mode !== "minted") throw needsOperatorCredential(row);
  // Only a path that mints needs the key; fetch it before that mint, never after.
  const publicKey = blobLive ? null : await stationPublicKey(deps, station);
  return advance(deps, row, station, provider, publicKey);
}

// ─── The steps ────────────────────────────────────────────────────────────────

export async function advance(
  deps: ForgeApiDeps,
  stale: Grant,
  station: StationRow,
  provider: ForgeProvider,
  publicKey: string | null,
): Promise<Grant> {
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    // Re-read under the claim: a request that held it before us may have moved the grant on.
    const row = await loadGrant(deps.db, stale);
    if (row.state === "revoking" || row.state === "revoked") {
      throw new ForgeApiGrantError("grant-not-deliverable", `forge grant ${row.id} is ${row.state}.`, row.id);
    }
    return advanceClaimed(deps, row, station, provider, publicKey);
  });
}

async function advanceClaimed(
  deps: ForgeApiDeps,
  row: Grant,
  station: StationRow,
  provider: ForgeProvider,
  publicKey: string | null,
): Promise<Grant> {
  const now = deps.now();
  const blobLive = blobIsLive(row, now);
  if (blobLive) {
    return rotationOf(row).rotating ? sendRotationBlob(deps, row, station) : sendDeliver(deps, row, station, row.sealedBlob!);
  }
  if (row.state === "delivered" || row.state === "verified") return row;
  // Never mint for a supplied/app grant: only the operator can produce its credential.
  if (row.mode !== "minted") throw needsOperatorCredential(row);
  if (!publicKey) {
    throw new ForgeApiGrantError("station-key-unavailable", `station ${station.id}: no stk handover key.`, row.id);
  }

  let current = row;
  if (current.tokenHandle) {
    // A token exists but no deliverable blob does, and the hub has no plaintext to re-seal.
    // Revoke it, then mint the next generation (spec: sealed-blob expiry).
    try {
      await revokeTolerant(provider, current.account, current.tokenHandle);
    } catch (err) {
      const reason = `re-mint blocked: revoking the undelivered token failed: ${scrub(err)}`;
      await transition(deps.db, current, [current.state], "failed", { now, stateReason: reason });
      log.warn("forge grant re-mint blocked", { grantId: current.id, stationId: station.id });
      throw new ForgeApiGrantError("revoke-failed", reason, current.id);
    }
    current = await deps.db.transaction(async (tx) => {
      const generation = await nextGeneration(tx, current.tenantId, current.stationIdSnapshot, current.provider, current.instance);
      return transition(tx, current, [current.state], "provisioned", {
        now,
        generation,
        tokenHandle: null,
        sealed: null,
        stateReason: "re-minting: the sealed blob expired before delivery",
      });
    });
  }
  return mintAndDeliver(deps, current, station, provider, publicKey);
}

/** The only function that ever holds the token. */
async function mintAndDeliver(
  deps: ForgeApiDeps,
  row: Grant,
  station: StationRow,
  provider: ForgeProvider,
  publicKey: string,
): Promise<Grant> {
  const ref = grantRef(row);
  const scopes = provider.mintScopes(ref);
  if (!provider.mint) throw new ForgeApiGrantError("mode-not-supported", `forge: ${provider.kind} cannot mint tokens.`, row.id);
  const name = tokenName(ref);
  const repositories = row.repositories.map(splitRepo);

  let minted: { id: number | undefined; name: string; secret: string };
  try {
    minted = await provider.mint(row.account, { name, scopes, repositories });
  } catch (err) {
    // Ambiguous: a timeout or 5xx may have created the token anyway. Revoke by the deterministic
    // name (best effort) so a retry can never leave two tokens under one name.
    await compensateRevoke(provider, row.account, { name }, row.id);
    const reason = `mint failed: ${scrub(err)}`;
    await transition(deps.db, row, [row.state], "failed", { now: deps.now(), stateReason: reason });
    log.warn("forge token mint failed", { grantId: row.id, stationId: station.id });
    throw new ForgeApiGrantError("mint-failed", reason, row.id);
  }
  let secret: string | undefined = minted.secret;
  const handle = minted.id === undefined ? { name: minted.name } : { id: minted.id, name: minted.name };

  // Persist the handle BEFORE sealing or delivering, so reconcile can always find this token.
  let current: Grant;
  try {
    current = await transition(deps.db, row, [row.state], "provisioned", { now: deps.now(), tokenHandle: handle });
  } catch (err) {
    // The token exists and nothing records it: take it back before anything else.
    await compensateRevoke(provider, row.account, handle, row.id, secret);
    secret = undefined;
    log.warn("forge token handle could not be persisted; minted token revoked", { grantId: row.id, stationId: station.id });
    throw new ForgeApiGrantError(
      "handle-persist-failed",
      `forge grant ${row.id}: the minted token could not be recorded (${scrub(err, minted.secret)}); it was revoked.`,
      row.id,
    );
  }

  let sealed: string;
  try {
    sealed = await deps.seal(publicKey, { token: secret });
  } catch (err) {
    const reason = `seal failed: ${scrub(err, secret)}`;
    secret = undefined;
    await transition(deps.db, current, ["provisioned"], "provisioned", { now: deps.now(), stateReason: reason });
    log.warn("forge token seal failed", { grantId: row.id, stationId: station.id });
    throw new ForgeApiGrantError("seal-failed", `forge grant ${row.id}: sealing the token failed.`, row.id);
  }
  secret = undefined;

  const now = deps.now();
  current = await transition(deps.db, current, ["provisioned"], "provisioned", {
    now,
    sealed: { blob: sealed, expiresAt: new Date(now.getTime() + SEALED_BLOB_TTL_MS) },
  });
  log.info("forge token minted and sealed", { grantId: row.id, stationId: station.id, generation: current.generation });
  return sendDeliver(deps, current, station, sealed);
}
