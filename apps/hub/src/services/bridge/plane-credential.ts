import type { OrgPlaneTokenClaims } from "@agentpod/contract";
import { BridgeCredentialSource } from "../../../../../packages/contract/src/bridge-credential";
export interface BridgeCredentialSnapshot {
  revision: string;
  principalId: string | null;
  org: string | null;
  owner: string;
  enabled: boolean;
}
/**
 * Why an exchanged plane grant was refused. A closed set of fixed words, safe to log: no token,
 * claim value or identifier ever enters it.
 */
export type BridgeCredentialRefusalReason =
  | "binding.changed" | "lifetime" | "claims.unverified" | "claims.kind" | "claims.sub" | "claims.org"
  | "claims.ent" | "claims.scope" | "claims.expired" | "binding.expired";

/** Thrown before any board request is sent: nothing was claimed or written with this grant. */
export class BridgeCredentialRefused extends Error {
  constructor(readonly reason: BridgeCredentialRefusalReason) {
    super(`Bridge credential claims refused: ${reason}`);
    this.name = "BridgeCredentialRefused";
  }
}

/** The scope an exchanged grant must carry for the bridge to claim with it. */
export const BRIDGE_CREDENTIAL_SCOPE = "claim";

/**
 * Every agent scope SuperPipeline defines (`AGENT_TOKEN_SCOPES`): `claim` to take a card, `run` for
 * the run's own verbs. A new station-plane source must carry both; spending still requires `claim`
 * alone, so a row admitted before this check is not refused mid-run.
 */
export const BRIDGE_REQUIRED_SCOPES = ["claim", "run"] as const;

/** The required scopes a verified grant lacks, in `BRIDGE_REQUIRED_SCOPES` order. */
export function missingBridgeScopes(claims: OrgPlaneTokenClaims): string[] {
  const held = new Set(claims.scope?.split(" ") ?? []);
  return BRIDGE_REQUIRED_SCOPES.filter((scope) => !held.has(scope));
}

/**
 * The first rule verified claims break for a station-plane source, or undefined. Shared by the
 * spend path and roster admission, so a row is never admitted with a grant it could not spend.
 */
export function planeClaimsRefusal(
  claims: OrgPlaneTokenClaims | null,
  expected: { principalId: string; org: string | null },
  now: number = Date.now(),
): BridgeCredentialRefusalReason | undefined {
  if (!claims) return "claims.unverified";
  if (claims.principalKind !== "agent") return "claims.kind";
  if (claims.sub !== expected.principalId) return "claims.sub";
  if (claims.org !== expected.org) return "claims.org";
  if (!claims.ent.includes("superpipeline")) return "claims.ent";
  if (!claims.scope?.split(" ").includes(BRIDGE_CREDENTIAL_SCOPE)) return "claims.scope";
  if (claims.exp * 1000 <= now) return "claims.expired";
  return undefined;
}

export function createBridgePlaneCredential(
  source: BridgeCredentialSource,
  expected: BridgeCredentialSnapshot,
  deps: {
    snapshot: () => Promise<BridgeCredentialSnapshot | null>;
    exchange: (
      principal: string,
      audience: string,
    ) => Promise<{ accessToken: string; expiresIn: number }>;
    verify: (token: string) => Promise<OrgPlaneTokenClaims | null>;
  },
): () => Promise<string> {
  const parsed = BridgeCredentialSource.parse(source);
  async function guard() {
    const current = await deps.snapshot();
    if (
      !current ||
      !current.enabled ||
      current.principalId !== parsed.principalId ||
      current.org !== parsed.organizationId ||
      JSON.stringify(current) !== JSON.stringify(expected)
    )
      throw new BridgeCredentialRefused("binding.changed");
  }
  return async () => {
    await guard();
    const issued = await deps.exchange(parsed.principalId, parsed.audience);
    if (
      !Number.isFinite(issued.expiresIn) ||
      issued.expiresIn <= 0 ||
      issued.expiresIn > 300
    )
      throw new BridgeCredentialRefused("lifetime");
    const claims = await deps.verify(issued.accessToken);
    const refusal = planeClaimsRefusal(claims, { principalId: parsed.principalId, org: expected.org });
    if (refusal || !claims) throw new BridgeCredentialRefused(refusal ?? "claims.unverified");
    await guard();
    if (claims.exp * 1000 <= Date.now())
      throw new BridgeCredentialRefused("binding.expired");
    return issued.accessToken;
  };
}
