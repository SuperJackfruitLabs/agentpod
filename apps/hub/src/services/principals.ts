/**
 * Principals, read from (and, for agents, created at) the organization plane (contract §3.5).
 *
 * The hub kept its own `principals`, `principal_identities` and `principal_grants` until the
 * rollback window after P4 closed; they were dropped in P3 plan Task 17. Every read here goes
 * through the directory (`./org-plane/directory.ts`): cached 60 s, last-good while the plane is
 * unreachable, and an `OrgPlaneError` when there is nothing to serve — callers fail closed.
 */
import { PrincipalId } from "@agentpod/contract";
import type { PrincipalKind } from "../db/schema/organization";
import { principalDirectory } from "./org-plane/directory";
import { orgPlaneClient, type PlanePrincipal } from "./org-plane/client";

/**
 * What `suspendedAt` reads as for a principal the org plane reports suspended. The plane gives a
 * boolean, not a time; every caller tests `suspendedAt` for truthiness, so the epoch is enough and
 * says plainly that the moment is unknown.
 */
export const SUSPENDED_AT_UNKNOWN = new Date(0);

/**
 * A principal, as the hub's callers use it. `email`/`emailVerified` are always null: the plane's
 * principal reads carry no email (contract §3.5), and nothing in the hub needs one any more — it
 * only fed the hub's own token minting.
 */
export interface ResolvedPrincipal {
  id: string;
  kind: PrincipalKind;
  suspendedAt: Date | null;
  email: string | null;
  emailVerified: boolean | null;
}

function fromPlane(p: PlanePrincipal): ResolvedPrincipal {
  return { id: p.id, kind: p.kind, suspendedAt: p.suspended ? SUSPENDED_AT_UNKNOWN : null, email: null, emailVerified: null };
}

/**
 * Create an agent principal at the plane. The plane creates agents only (contract §3.5); humans
 * are created by signing up there, services by the plane's operator.
 */
export async function createPrincipal(input: { kind: PrincipalKind; handle: string; displayName?: string }): Promise<string> {
  if (input.kind !== "agent") throw new Error(`the org plane creates ${input.kind} principals itself`);
  const { id } = await orgPlaneClient().createAgent({ handle: input.handle, displayName: input.displayName ?? input.handle });
  principalDirectory().invalidate();
  return id;
}

/**
 * The human principal behind an `AuthUser.id`, or null. An account id IS the human's `prn_`
 * (contract §2, "Migrated humans"). Null rather than a fallback: an unmapped caller must fail
 * closed.
 */
export async function principalForUser(userId: string): Promise<ResolvedPrincipal | null> {
  const p = await principalDirectory().principal(userId);
  return p && p.kind === "human" ? fromPlane(p) : null;
}

/** A principal by its own id, or null. */
export async function principalById(id: string): Promise<ResolvedPrincipal | null> {
  const p = await principalDirectory().principal(id);
  return p ? fromPlane(p) : null;
}

/**
 * A principal's immutable `handle`, or null.
 *
 * This is what an agent's Matrix identity is built from
 * (`charter` → decisions/2026-08-30-an-agent-is-a-principal.md): `names.ts`'s
 * `bridgeUserId`/`bridgeLocalpart` take a handle, not a station.
 *
 * Null both when the id names nobody and when a station has none — the two cases a caller must
 * treat alike: fail closed, never invent an address.
 */
export async function principalHandle(id: string): Promise<string | null> {
  return (await principalDirectory().principal(id))?.handle ?? null;
}

/** A principal's handle and display name, or null. The display name is null when none was set. */
export async function principalNames(id: string): Promise<{ handle: string; displayName: string | null } | null> {
  const p = await principalDirectory().principal(id);
  return p ? { handle: p.handle, displayName: p.displayName } : null;
}

/**
 * Every principal in the hub's workspace, for the admin surface and the dispatchable picker.
 *
 * `userId` is the account id a human signs in as — under the plane, the principal's own id
 * (contract §2). It is null for an agent or a service, which is the ordinary case and not a gap.
 */
export async function listPrincipals(): Promise<
  Array<{
    id: string;
    kind: PrincipalKind;
    handle: string;
    displayName: string | null;
    userId: string | null;
    suspendedAt: Date | null;
  }>
> {
  return (await principalDirectory().list()).map((p) => ({
    id: p.id,
    kind: p.kind,
    handle: p.handle,
    displayName: p.displayName,
    userId: p.kind === "human" ? p.id : null,
    suspendedAt: p.suspended ? SUSPENDED_AT_UNKNOWN : null,
  }));
}

/**
 * The human principal behind an `AuthUser.id`, or null. They are the same string (contract §2),
 * so no read is needed.
 */
export async function humanPrincipalIdForUser(userId: string): Promise<string | null> {
  return PrincipalId.safeParse(userId).success ? userId : null;
}
