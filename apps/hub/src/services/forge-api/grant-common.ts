/**
 * Helpers every step of the forge grant lifecycle shares: scrubbing errors, revoking at the
 * provider, the row reads, the same-user acknowledgement rule, and node-text sanitising.
 */
import type { ForgeApiPreset, ForgeApiRule } from "@agentpod/contract";
import { and, eq } from "drizzle-orm";

import type { DbExecutor } from "../../db/drizzle";
import { stationForgeApiGrants as g, type ForgeTokenRef } from "../../db/schema/forge-api-grants";
import { stations } from "../../db/schema/stations";
import { ForgeApiGrantError } from "./errors";
import { log } from "./grant-log";
import type { ForgeApiDeps, Grant, GrantRef, StationRow } from "./grant-types";
import type { ForgeGrantRef, ForgeProvider } from "./providers";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** An error's message, without the token if one is known, bounded. Never the error object. */
export function scrub(err: unknown, secret?: string): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (secret) msg = msg.split(secret).join("[redacted]");
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/** A provider 404 on revoke means the token is already gone: the end state asked for. */
function isNotFound(err: unknown): boolean {
  if ((err as { status?: unknown })?.status === 404) return true;
  return err instanceof Error && /\bHTTP 404\b/.test(err.message);
}

/** Revoke, treating "already gone" as success. */
export async function revokeTolerant(provider: ForgeProvider, account: string, handle: ForgeTokenRef) {
  if (!provider.revoke) throw new Error(`forge: ${provider.kind} cannot revoke tokens.`);
  try {
    await provider.revoke(account, handle);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/** Best-effort compensation: never throws, never logs more than ids and a scrubbed message. */
export async function compensateRevoke(
  provider: ForgeProvider,
  account: string,
  handle: ForgeTokenRef,
  grantId: string,
  secret?: string,
): Promise<boolean> {
  try {
    await revokeTolerant(provider, account, handle);
    return true;
  } catch (err) {
    log.warn("forge compensating revoke failed; reconcile will find the token by name", {
      grantId,
      tokenName: handle.name,
      error: scrub(err, secret),
    });
    return false;
  }
}

/** `forge-<provider>-<12 chars of the grant id>`: stable per grant, safe as an stk service name. */
export function serviceNameFor(grant: Pick<Grant, "id" | "provider">): string {
  const short = grant.id.replace(/[^a-zA-Z0-9]/g, "").slice(-12).toLowerCase();
  return `forge-${grant.provider}-${short}`;
}

export async function loadStation(db: DbExecutor, tenantId: string, stationId: string): Promise<StationRow> {
  const [st] = await db
    .select()
    .from(stations)
    .where(and(eq(stations.tenantId, tenantId), eq(stations.id, stationId)));
  if (!st) throw new ForgeApiGrantError("station-not-found", `station ${stationId} not found.`);
  return st;
}

export async function loadGrant(db: DbExecutor, ref: GrantRef): Promise<Grant> {
  const [row] = await db.select().from(g).where(and(eq(g.tenantId, ref.tenantId), eq(g.id, ref.id)));
  if (!row) throw new ForgeApiGrantError("grant-not-found", `forge grant ${ref.id} not found.`, ref.id);
  return row;
}

// ─── same-user acknowledgement (spec: a write preset in same-user mode needs it) ───────────────

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const SAME_USER_ACK_REQUIRED = "same-user-acknowledgement-required";

/**
 * Every preset except `read` is a write preset; so is `read` with an allow rule for a write method,
 * and so is any grant that allows GraphQL (its mutations cannot be rule-checked).
 */
export function isWriteGrant(p: { preset: ForgeApiPreset; rules: readonly unknown[]; allowGraphql?: boolean }): boolean {
  if (p.preset !== "read" || p.allowGraphql === true) return true;
  return (p.rules as ForgeApiRule[]).some(
    (r) => typeof r?.allow === "string" && !READ_METHODS.has(r.allow.trim().split(/\s+/)[0]!.toUpperCase()),
  );
}

export function sameUserRequired(id: string, grantId?: string): ForgeApiGrantError {
  return new ForgeApiGrantError(
    SAME_USER_ACK_REQUIRED,
    `station ${id}: the broker runs in same-user mode (or the node has not shown otherwise), so a write grant needs the operator's same-user acknowledgement.`,
    grantId,
  );
}

export function grantRef(row: Grant): ForgeGrantRef {
  return {
    id: row.id,
    provider: row.provider,
    instance: row.instance,
    mode: row.mode,
    account: row.account,
    expectedLogin: row.expectedLogin,
    preset: row.preset,
    repositories: row.repositories,
    generation: row.generation,
  };
}

export const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

const NODE_REASON_MAX = 200;

/** A node-supplied string, safe to store: control characters removed, length capped. */
export function untrusted(s: unknown): string {
  const clean = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return clean.length > NODE_REASON_MAX ? `${clean.slice(0, NODE_REASON_MAX)}…` : clean;
}

export function isUnknownVerb(error: string): boolean {
  return /unknown verb/i.test(error);
}

export const bareHandle = (h: ForgeTokenRef): ForgeTokenRef => (h.id === undefined ? { name: h.name } : { id: h.id, name: h.name });

export const blobIsLive = (row: Grant, now: Date) =>
  !!row.sealedBlob && !!row.sealedExpiresAt && row.sealedExpiresAt.getTime() > now.getTime();

/**
 * The login the node must see. minted: the stored expected login (the occupant). supplied/app: the
 * provider's view of the declared login (GitHub app: `<slug>[bot]`).
 */
export function expectLoginFor(deps: Pick<ForgeApiDeps, "providers">, row: Grant): string {
  if (row.mode === "minted") return row.expectedLogin ?? row.account;
  return deps.providers(row.provider).expectedIdentity(grantRef(row));
}

export function revokingError(row: Grant): ForgeApiGrantError {
  return new ForgeApiGrantError("grant-revoking", `forge grant ${row.id} is being revoked; nothing was delivered.`, row.id);
}

export function needsOperatorCredential(row: Grant): ForgeApiGrantError {
  return new ForgeApiGrantError(
    "grant-not-deliverable",
    `forge grant ${row.id} (${row.mode}) has no deliverable credential; the operator must supply a new sealed one.`,
    row.id,
  );
}
