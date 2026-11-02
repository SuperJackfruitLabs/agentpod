/**
 * Creating a grant: every check that can refuse it before a row or a token exists, the row
 * (inserted, or the live one carried forward), the audit row, and, for minted mode, the first
 * mint → seal → deliver (`advance`).
 */
import { and, eq, ne } from "drizzle-orm";

import type { DbExecutor } from "../../db/drizzle";
import { stationForgeApiGrants as g } from "../../db/schema/forge-api-grants";
import { principalHandle } from "../../auth/org-plane/principals";
import { recordAudit } from "../audit";
import { ForgeApiConfigError, ForgeApiGrantError } from "./errors";
import { nextGeneration } from "./generation";
import { isWriteGrant, loadStation, sameList, sameUserRequired, scrub } from "./grant-common";
import { advance } from "./grant-mint";
import { stationStatus } from "./grant-node";
import type { CreateForgeApiGrantInput, ForgeApiDeps, Grant, StationRow } from "./grant-types";
import { isConfiguredForge } from "./instance";
import { splitRepo, type ForgeGrantRef, type ForgeProvider } from "./providers";

// ─── createForgeApiGrant ──────────────────────────────────────────────────────

/**
 * Grant a station repository-restricted API access, minted mode: validate, fetch the station's
 * public key, insert `authorised` (or find the live grant for the same station/provider/instance
 * and carry it forward instead of minting again), then mint, seal and deliver.
 *
 * Throws `ForgeApiGrantError`/`ForgeApiConfigError` for anything refused before a token exists and
 * for mint/seal faults. A delivery outcome (node offline, refused, no positive ack) is NOT thrown:
 * the returned row's `state` and `stateReason` say what happened.
 */
export async function createForgeApiGrant(deps: ForgeApiDeps, input: CreateForgeApiGrantInput): Promise<Grant> {
  const minted = input.mode === "minted";
  // Pure checks first, before the station is even read: does the provider offer this mode, and a
  // minted token belongs to the configured forge only.
  const provider = deps.providers(input.provider);
  if (!provider.modes.includes(input.mode)) {
    throw new ForgeApiGrantError("mode-not-supported", `forge: ${input.provider} does not offer ${input.mode} grants.`);
  }
  if (minted && !isConfiguredForge(input.instance, deps.forgeOrigin)) {
    throw new ForgeApiConfigError(
      "instance-not-forge",
      "forge: a minted grant's instance must be this hub's configured forge (same https origin).",
    );
  }
  const station = await loadStation(deps.db, input.tenantId, input.stationId);
  const { principalId, account } = await grantAccount(input, station, minted);
  checkGrantShape(input, station, provider, account, minted);

  // BEFORE any mint: no key means no seal, and a token that cannot be sealed is an orphan.
  // supplied/app never mint and never seal: the operator sealed the credential client-side.
  const status = minted ? await stationStatus(deps, station) : null;
  const publicKey = status?.publicKey ?? null;
  // Fail closed: a write grant needs the acknowledgement unless the node showed separate-user
  // isolation (supplied/app make no status call here, so they always need it for write).
  const ack = input.acknowledgeSameUser === true;
  if (isWriteGrant(input) && !ack && !status?.separateUser) throw sameUserRequired(station.id);

  const now = deps.now();
  const { row, created } = await deps.db.transaction((tx) => liveOrInserted(tx, input, station, { principalId, account, ack, now }));
  if (!created) refuseUnlikeLive(row, input, station, account);

  const audit = await recordAudit(deps.db, {
    tenantId: station.tenantId,
    userId: input.actor,
    nodeId: station.nodeId,
    stationKey: station.stationKey,
    verb: "forge.api.grant",
    // Only keys already on audit.ts's allowlist; the grant's own fields go there in Task 7.
    params: { stationKey: station.stationKey, key: row.id, kind: row.provider, action: `${row.mode}:${row.preset}` },
  });
  // supplied/app stop at `authorised`: the credential arrives through acceptSuppliedSecret.
  if (!minted) {
    await audit.done("ok", "awaiting the operator's sealed credential");
    return row;
  }
  try {
    const out = await advance(deps, row, station, provider, publicKey);
    await audit.done(out.state === "delivered" || out.state === "verified" ? "ok" : "error", out.stateReason ?? undefined);
    return out;
  } catch (err) {
    await audit.done("error", err instanceof ForgeApiGrantError ? err.message : "forge grant failed");
    throw err;
  }
}

/**
 * minted: the account is the occupant's handle, and nothing in `input` can name it.
 * supplied/app: the account is the machine/bot login the operator created and declares; the
 * occupant (if any) is still recorded as principalId.
 */
async function grantAccount(
  input: CreateForgeApiGrantInput,
  station: StationRow,
  minted: boolean,
): Promise<{ principalId: string | null; account: string }> {
  const principalId = station.principalId;
  let account: string | null;
  if (minted) {
    account = principalId ? await principalHandle(principalId) : null;
    if (!principalId || !account) {
      throw new ForgeApiGrantError("no-occupant", `station ${station.id} has no occupant to grant forge access to.`);
    }
  } else {
    account = input.expectedLogin?.trim() || null;
    if (!account) {
      throw new ForgeApiGrantError(
        "expected-login-required",
        `forge: a ${input.mode} grant needs the login the operator created (app: the App slug).`,
      );
    }
  }
  return { principalId, account };
}

/** The node's capability, the repositories, and the scopes or the declared login. */
function checkGrantShape(
  input: CreateForgeApiGrantInput,
  station: StationRow,
  provider: ForgeProvider,
  account: string,
  minted: boolean,
): void {
  if (!(station.capabilities ?? []).includes("forge.api")) {
    throw new ForgeApiGrantError("capability-missing", `station ${station.id}'s node does not support forge.api; update the node.`);
  }
  for (const repo of input.repositories) {
    try {
      splitRepo(repo);
    } catch (err) {
      throw new ForgeApiGrantError("bad-repository", scrub(err));
    }
  }
  const probe: ForgeGrantRef = {
    id: "pending",
    provider: input.provider,
    instance: input.instance,
    mode: input.mode,
    account,
    expectedLogin: account,
    preset: input.preset,
    repositories: input.repositories,
    generation: 1,
  };
  if (minted) {
    // Scope check up front: a config mistake (preset "none", …) is a 422 before any row or token.
    provider.mintScopes(probe);
  } else {
    // The declared login must be one the provider can verify against (app: a slug, no "[bot]").
    try {
      provider.expectedIdentity(probe);
    } catch (err) {
      throw new ForgeApiGrantError("bad-expected-login", scrub(err));
    }
  }
}

/** The live grant for this station/provider/instance, or a new `authorised` one (in `tx`). */
async function liveOrInserted(
  tx: DbExecutor,
  input: CreateForgeApiGrantInput,
  station: StationRow,
  row: { principalId: string | null; account: string; ack: boolean; now: Date },
): Promise<{ row: Grant; created: boolean }> {
  const { principalId, account, ack, now } = row;
  const findLive = async () =>
    (
      await tx
        .select()
        .from(g)
        .where(
          and(
            eq(g.tenantId, input.tenantId),
            eq(g.stationIdSnapshot, station.id),
            eq(g.provider, input.provider),
            eq(g.instance, input.instance),
            ne(g.state, "revoked"),
          ),
        )
    )[0];
  // Reusing a live row needs no generation. Otherwise take the (tenant, station, provider,
  // instance) lock via nextGeneration and look again under it, so a racing insert is seen.
  const seen = await findLive();
  if (seen) return { row: seen, created: false };
  const generation = await nextGeneration(tx, input.tenantId, station.id, input.provider, input.instance);
  const live = await findLive();
  if (live) return { row: live, created: false };
  const [inserted] = await tx
    .insert(g)
    .values({
      id: `fag_${crypto.randomUUID().replace(/-/g, "")}`,
      tenantId: input.tenantId,
      stationId: station.id,
      stationIdSnapshot: station.id,
      provider: input.provider,
      instance: input.instance,
      mode: input.mode,
      principalId,
      account,
      expectedLogin: account,
      repositories: input.repositories,
      preset: input.preset,
      rules: input.rules,
      allowGraphql: input.allowGraphql,
      state: "authorised",
      generation,
      sameUserAckAt: ack ? now : null,
      sameUserAckBy: ack ? input.actor : null,
      createdBy: input.actor,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { row: inserted!, created: true };
}

/** A live grant is carried forward only when it is not being revoked and asks for the same. */
function refuseUnlikeLive(row: Grant, input: CreateForgeApiGrantInput, station: StationRow, account: string): void {
  if (row.state === "revoking") {
    // Not "revoke it first": it is being revoked. A new grant can be made once it is a tombstone.
    throw new ForgeApiGrantError(
      "grant-revoking",
      `station ${station.id}'s ${row.provider} grant for ${row.instance} (${row.id}): revocation is in progress; try again once it is revoked.`,
      row.id,
    );
  }
  const same =
    row.mode === input.mode &&
    row.preset === input.preset &&
    row.allowGraphql === input.allowGraphql &&
    row.account === account &&
    sameList(row.repositories, input.repositories) &&
    JSON.stringify(row.rules) === JSON.stringify(input.rules);
  if (!same) {
    throw new ForgeApiGrantError(
      "grant-exists",
      `station ${station.id} already has a ${row.provider} grant for ${row.instance} (${row.id}); revoke it first.`,
      row.id,
    );
  }
}
