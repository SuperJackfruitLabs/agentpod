import type { ForgeApiPreset } from "@agentpod/contract";

import { ForgeApiConfigError } from "./errors";
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
    async checkToken(_account, secret) {
      const cfg = need();
      const fetchImpl = deps.fetchImpl ?? fetch;
      let res: Response;
      try {
        res = await fetchImpl(`${cfg.baseUrl}/api/v1/user`, {
          method: "GET",
          headers: { Authorization: `token ${secret}`, Accept: "application/json" },
        });
      } catch {
        // The underlying error may quote the request; say nothing of it.
        throw new Error("forge: checking the new token failed (network error).");
      }
      if (!res.ok) throw new Error(`forge: checking the new token failed (HTTP ${res.status}).`);
      let login: unknown;
      try {
        login = ((await res.json()) as { login?: unknown }).login;
      } catch {
        throw new Error("forge: checking the new token failed (unreadable reply).");
      }
      if (typeof login !== "string" || !login) throw new Error("forge: checking the new token failed (no login).");
      return { login };
    },
    expectedIdentity(grant) {
      if (grant.mode === "supplied") {
        if (!grant.expectedLogin) throw new Error("forge: a supplied grant needs its declared login.");
        return grant.expectedLogin;
      }
      return grant.account;
    },
    mintScopes(grant) {
      if (grant.mode !== "minted") {
        throw new ForgeApiConfigError("mode-not-minted", `forge: a ${grant.mode} grant does not mint a token, so it has no mint scopes.`);
      }
      if (grant.preset === "none") {
        throw new ForgeApiConfigError("preset-none-needs-no-token", 'forge: preset "none" grants no scopes, so a minted token cannot be made for it.');
      }
      return this.scopesFor(grant.preset);
    },
    scopesFor(preset) {
      if (preset === "none") {
        throw new Error('forge: preset "none" has no scopes; a minted token needs a preset that grants some.');
      }
      return [...SCOPES[preset]];
    },
  };
}
