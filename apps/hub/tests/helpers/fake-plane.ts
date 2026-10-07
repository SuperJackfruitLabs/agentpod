/**
 * An in-memory organization plane for the hub's tests.
 *
 * Since the hub's own auth and principal tables were dropped (P3 plan, Task 17), the org plane is
 * the only place a principal, a grant or a Matrix identity lives. `tests/preload.ts` installs this
 * fake for the whole run, in place of the HTTP client, so code under test reaches it through the
 * real `orgPlaneClient()` / `principalDirectory()` seams:
 *
 * - `createPrincipal`, `setGrant`, `createPlaneAgent` write here;
 * - `principalById`, `getGrant`, `resolveMatrixId`, `matrixIdForPrincipal`, `listPrincipals` read here (no cache: the
 *   directory over it has a zero TTL, so a test sees its own writes at once);
 * - `signPlaneToken` mints a real EdDSA token the hub's verifier accepts (its key set is this
 *   module's), for the tests that go through `authMiddleware` or a self-authenticating door.
 *
 * It answers like the plane: 404 is null, a taken handle is `OrgPlaneError(409)`, an unknown
 * principal on a write is `OrgPlaneError(404)`. Imports nothing that touches the database.
 */
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import {
  OrgPlaneError,
  orgPlaneClient,
  setOrgPlaneClientForTests,
  type OrgPlaneClient,
  type PlaneGrant,
  type PlaneKind,
  type PlanePrincipal,
} from "../../src/services/org-plane/client";
import { setOrgPlaneForTests, TEST_PLANE } from "../../src/auth/org-plane/config";
import { createPrincipalDirectory, setPrincipalDirectoryForTests } from "../../src/services/org-plane/directory";
import { createPlaneVerifier, setPlaneVerifierForTests } from "../../src/auth/org-plane/verify";

/** The org every test token names unless it says otherwise. */
export const TEST_ORG = "org_00000000000000000000";

const hex20 = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
export const newPrincipalId = () => `prn_${hex20()}`;

export interface FakePlane extends OrgPlaneClient {
  /** Add (or replace) a human. Returns its id. */
  addHuman(input?: { id?: string; handle?: string; displayName?: string | null; grant?: Partial<PlaneGrant>; matrixId?: string; suspended?: boolean }): string;
  /** Add an agent directly, as the plane's pages would. Returns its id. */
  addAgent(input?: { id?: string; handle?: string; displayName?: string | null; matrixId?: string; suspended?: boolean }): string;
  /** Forget a principal and its identities. */
  remove(id: string): void;
  /** Every principal, for assertions. */
  readonly principals: Map<string, PlanePrincipal>;
  /** `${system}\u0000${externalId}` → principal id. */
  readonly identities: Map<string, string>;
}

export function createFakePlane(): FakePlane {
  const principals = new Map<string, PlanePrincipal>();
  const identities = new Map<string, string>();
  const key = (system: string, externalId: string) => `${system}\u0000${externalId}`;

  function add(kind: PlaneKind, input: { id?: string; handle?: string; displayName?: string | null; grant?: Partial<PlaneGrant>; matrixId?: string; suspended?: boolean }): string {
    const id = input.id ?? newPrincipalId();
    const existing = principals.get(id);
    principals.set(id, {
      id,
      kind,
      handle: input.handle ?? existing?.handle ?? `${kind}-${id.slice(4, 12)}`,
      displayName: input.displayName ?? existing?.displayName ?? null,
      organizationId: TEST_ORG,
      suspended: input.suspended ?? existing?.suspended ?? false,
      grant: input.grant
        ? { mayDispatch: input.grant.mayDispatch ?? [], mayGrantReach: input.grant.mayGrantReach ?? false, scopes: input.grant.scopes ?? [] }
        : (existing?.grant ?? null),
    });
    if (input.matrixId) link(id, "matrix", input.matrixId);
    return id;
  }

  function link(id: string, system: string, externalId: string) {
    // One identity per (principal, system): PUT replaces.
    for (const [k, v] of identities) if (v === id && k.startsWith(`${system}\u0000`)) identities.delete(k);
    identities.set(key(system, externalId), id);
  }

  function must(id: string): PlanePrincipal {
    const p = principals.get(id);
    if (!p) throw new OrgPlaneError(404, "unknown_principal");
    return p;
  }

  const clone = (p: PlanePrincipal): PlanePrincipal => ({ ...p, grant: p.grant ? { ...p.grant, mayDispatch: [...p.grant.mayDispatch], scopes: [...p.grant.scopes] } : null });

  return {
    principals,
    identities,
    addHuman: (input = {}) => add("human", input),
    addAgent: (input = {}) => add("agent", input),
    remove(id) {
      principals.delete(id);
      for (const [k, v] of identities) if (v === id) identities.delete(k);
    },

    async agentToken(principal, audience) {
      const p = must(principal);
      if (p.suspended) throw new OrgPlaneError(423, "suspended");
      return {
        accessToken: await signPlaneToken({ sub: p.id, principalKind: p.kind, aud: audience, mayDispatch: p.grant?.mayDispatch ?? [] }),
        expiresIn: 300,
      };
    },
    async assertionToken(identity, audience) {
      const id = identities.get(key(identity.system, identity.externalId));
      if (!id) throw new OrgPlaneError(404, "unknown_identity");
      const p = must(id);
      if (p.kind !== "human") throw new OrgPlaneError(409, "not_human");
      if (p.suspended) throw new OrgPlaneError(423, "suspended");
      return { accessToken: await signPlaneToken({ sub: p.id, aud: audience, amr: ["assertion"] }), expiresIn: 120 };
    },
    async createAgent({ handle, displayName }) {
      // An agent's handle is its Matrix address, so two agents cannot share one.
      for (const p of principals.values()) if (p.kind === "agent" && p.handle === handle) throw new OrgPlaneError(409, "handle_taken");
      return { id: add("agent", { handle, displayName }) };
    },
    async putGrant(id, grant) {
      const p = must(id);
      p.grant = { mayDispatch: [...grant.mayDispatch], mayGrantReach: grant.mayGrantReach, scopes: [...grant.scopes] };
    },
    async linkIdentity(id, system, externalId) {
      must(id);
      const holder = identities.get(key(system, externalId));
      if (holder && holder !== id) throw new OrgPlaneError(409, "identity_taken");
      link(id, system, externalId);
    },
    async lookupIdentity(system, externalId) {
      const id = identities.get(key(system, externalId));
      const p = id ? principals.get(id) : undefined;
      return p ? { principalId: p.id, kind: p.kind, suspended: p.suspended } : null;
    },
    async identitiesOf(id, system) {
      if (!principals.has(id)) return null;
      const out: Array<{ system: string; externalId: string }> = [];
      for (const [k, v] of identities) {
        const [sys, externalId] = k.split("\u0000") as [string, string];
        if (v === id && sys === system) out.push({ system: sys, externalId });
      }
      return out;
    },
    async getPrincipal(id) {
      const p = principals.get(id);
      return p ? clone(p) : null;
    },
    async listPrincipals(kind) {
      return [...principals.values()].filter((p) => p.kind === kind).map(clone);
    },
    async suspend(id) {
      must(id).suspended = true;
    },
    async unsuspend(id) {
      must(id).suspended = false;
    },
  };
}

// ── Tokens ────────────────────────────────────────────────────────────────────

let keys: Promise<{ privateKey: CryptoKey; jwk: JWK }> | null = null;
const KID = "fake-plane-key";

function signingKey() {
  keys ??= (async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
    return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid: KID, alg: "EdDSA", use: "sig" } };
  })();
  return keys;
}

/** The key set the fake plane publishes — what the hub's verifier is pointed at in tests. */
export async function fakePlaneJwks(): Promise<{ keys: JWK[] }> {
  return { keys: [(await signingKey()).jwk] };
}

/**
 * A token the hub accepts: signed by the fake plane's key, for `TEST_PLANE`'s issuer and
 * audience, five minutes, `org` = `TEST_ORG` with `agentpod` entitled. Override any claim.
 */
export async function signPlaneToken(claims: { sub: string } & Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    principalKind: "human",
    org: TEST_ORG,
    ent: ["agentpod"],
    mayDispatch: [],
    mayGrantReach: false,
    ...claims,
  };
  const { aud, iss, exp, iat, jti, ...rest } = body as Record<string, unknown>;
  return new SignJWT(rest)
    .setProtectedHeader({ alg: "EdDSA", kid: KID })
    .setIssuer((iss as string) ?? TEST_PLANE.issuer)
    .setAudience((aud as string | string[]) ?? TEST_PLANE.audience)
    .setIssuedAt((iat as number) ?? now)
    .setExpirationTime((exp as number) ?? now + 300)
    .setJti((jti as string) ?? crypto.randomUUID())
    .sign((await signingKey()).privateKey);
}

// ── The run-wide instance ─────────────────────────────────────────────────────

/** The fake plane `tests/preload.ts` installs. Tests add their principals here. */
export const fakePlane: FakePlane = createFakePlane();

/**
 * Point the hub at the fake plane: `TEST_PLANE`'s settings, this client, a zero-TTL directory over
 * whatever client is installed, and a verifier that trusts this module's key. `tests/preload.ts`
 * calls it for every `bun test` run; a script run outside `bun test` (the skills e2e) calls it
 * itself.
 */
export function installFakePlane(): void {
  setOrgPlaneForTests(TEST_PLANE);
  setOrgPlaneClientForTests(fakePlane);
  setPrincipalDirectoryForTests(createPrincipalDirectory({ client: () => orgPlaneClient(), ttlMs: 0 }));
  setPlaneVerifierForTests(
    createPlaneVerifier({
      issuer: TEST_PLANE.issuer,
      audience: TEST_PLANE.audience,
      jwksUrl: TEST_PLANE.jwksUrl,
      fetch: async () => Response.json(await fakePlaneJwks()),
    }),
  );
}
