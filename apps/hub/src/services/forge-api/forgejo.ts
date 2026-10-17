import type { ForgeApiPreset } from "@agentpod/contract";

import { mintAgentToken, revokeAgentToken } from "../forge";
import type { ForgeGrantRef, ForgeProvider, ProviderDeps } from "./providers";

const SCOPES: Record<Exclude<ForgeApiPreset, "none">, string[]> = {
  read: ["read:repository"],
  issues: ["read:repository", "write:issue"],
  "pull-requests": ["read:repository", "write:issue", "write:repository"],
  maintain: ["write:repository", "write:issue"],
};

/** One name per grant generation, so a rotation never collides with the token it replaces. */
export function tokenName(grant: Pick<ForgeGrantRef, "id" | "generation">): string {
  return `agentpod-${grant.id}-g${grant.generation}`;
}

export function createForgejoProvider(deps: ProviderDeps): ForgeProvider {
  const need = () => {
    if (!deps.cfg) throw new Error("forge: the forgejo provider needs the forge admin config to mint or revoke.");
    return deps.cfg;
  };
  return {
    kind: "forgejo",
    modes: ["minted", "supplied"],
    async mint(account, spec) {
      const minted = await mintAgentToken(need(), account, spec, deps.fetchImpl);
      return { id: minted.id, name: minted.name, secret: minted.secret };
    },
    async revoke(account, handle) {
      await revokeAgentToken(need(), account, handle.name, deps.fetchImpl);
    },
    expectedIdentity(grant) {
      if (grant.mode === "supplied") {
        if (!grant.expectedLogin) throw new Error("forge: a supplied grant needs its declared login.");
        return grant.expectedLogin;
      }
      return grant.account;
    },
    scopesFor(preset) {
      if (preset === "none") {
        throw new Error('forge: preset "none" has no scopes; a minted token needs a preset that grants some.');
      }
      return [...SCOPES[preset]];
    },
  };
}
