import type { OrgPlaneTokenClaims } from "@agentpod/contract";
import { BridgeCredentialSource } from "../../../../../packages/contract/src/bridge-credential";
export interface BridgeCredentialSnapshot {
  revision: string;
  principalId: string | null;
  org: string | null;
  owner: string;
  enabled: boolean;
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
      throw Error("Bridge station credential binding changed");
  }
  return async () => {
    await guard();
    const issued = await deps.exchange(parsed.principalId, parsed.audience);
    if (
      !Number.isFinite(issued.expiresIn) ||
      issued.expiresIn <= 0 ||
      issued.expiresIn > 300
    )
      throw Error("Invalid bridge credential lifetime");
    const claims = await deps.verify(issued.accessToken);
    if (
      !claims ||
      claims.principalKind !== "agent" ||
      claims.sub !== parsed.principalId ||
      claims.org !== expected.org ||
      !claims.ent.includes("superpipeline") ||
      !claims.scope?.split(" ").includes("claim") ||
      claims.exp * 1000 <= Date.now()
    )
      throw Error("Bridge credential claims refused");
    await guard();
    if (claims.exp * 1000 <= Date.now())
      throw Error("Bridge credential expired during binding check");
    return issued.accessToken;
  };
}
