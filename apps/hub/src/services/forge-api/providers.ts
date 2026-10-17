/**
 * Hub-side provider adapters: mint and revoke the provider-side token for a grant.
 *
 * The hub never stores the token. It exists in memory between mint and sealing, and nothing here
 * logs it, returns it in an error, or echoes a response body.
 */
import type { ForgeApiMode, ForgeApiPreset, ForgeApiProvider } from "@agentpod/contract";

import type { FetchLike, ForgeConfig } from "../forge";
import { createForgejoProvider } from "./forgejo";
import { githubProvider } from "./github";

/** Structural view of a grant row; the grants table's row type satisfies it. */
export interface ForgeGrantRef {
  id: string;
  provider: ForgeApiProvider;
  instance: string;
  mode: ForgeApiMode;
  account: string;
  expectedLogin: string | null;
  preset: ForgeApiPreset;
  repositories: string[];
  generation: number;
}

export interface MintSpec {
  name: string;
  scopes: string[];
  repositories: { owner: string; name: string }[];
}

export interface ForgeProvider {
  kind: ForgeApiProvider;
  modes: ForgeApiMode[];
  mint?(account: string, spec: MintSpec): Promise<{ id: number; name: string; secret: string }>;
  revoke?(account: string, handle: { id?: number; name: string }): Promise<void>;
  /** The login a verifying read call must come back as. */
  expectedIdentity(grant: ForgeGrantRef): string;
  scopesFor(preset: ForgeApiPreset): string[];
}

export interface ProviderDeps {
  /** The forge admin connection; required for providers that mint. */
  cfg?: ForgeConfig;
  fetchImpl?: FetchLike;
}

export function getProvider(kind: ForgeApiProvider, deps: ProviderDeps = {}): ForgeProvider {
  switch (kind) {
    case "forgejo":
      return createForgejoProvider(deps);
    case "github":
      return githubProvider;
    default:
      // gitea and bitbucket are specified, built later.
      throw new Error(`forge: provider not supported yet (${kind}).`);
  }
}

/** `owner/name` into its parts. Exactly one slash, both sides non-empty. */
export function splitRepo(repo: string): { owner: string; name: string } {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`forge: repository must be "owner/name", got ${JSON.stringify(repo)}.`);
  }
  return { owner: parts[0], name: parts[1] };
}
