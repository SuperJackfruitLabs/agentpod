/**
 * The capability catalog and the registry beside it, as the hub answers them (charter decision
 * 2026-11-13, AgentPod owns the capability catalog).
 *
 * - The **catalog** is what exists in the workspace: harnesses, managed skill profiles, MCP
 *   servers, CLIs and the services a station's broker offers. One entry per id.
 * - The **registry** is who has it: for each station, its isolation, the model it was last seen
 *   running, the catalog entries it can use and the credential names it can reach, each fact with
 *   how it is known.
 *
 * Names only, never secrets: a credential is its name (`forge:github`), never a token, a key or a
 * handle to one.
 */

import {
  CatalogKind as CatalogKindSchema,
  CatalogProof,
  IsolationLevel as IsolationLevelSchema,
  type CatalogEntry,
  type IsolationLevel,
  type StationCapabilities,
  type StationCredential,
  type StationTool,
} from "@agentpod/contract";

export type { CatalogEntry, IsolationLevel, StationCapabilities, StationCredential, StationTool };
export type CatalogKind = (typeof CATALOG_KINDS)[number];
export type Proof = (typeof PROOFS)[number];

/** The shapes are the contract's (`packages/contract/src/capability-catalog.ts`). */
export const CATALOG_KINDS = CatalogKindSchema.options;
/** Strongest first. */
export const PROOFS = CatalogProof.options;
/** Weakest first. */
export const ISOLATION_LEVELS = IsolationLevelSchema.options;

/** What the hub knows about one station, read from its own tables, before it is shaped. */
export interface StationFacts {
  stationId: string;
  principalId: string | null;
  harness: string;
  /** The newest live runtime AgentPod provisioned for the station's node; null for an enrolled host. */
  runtime: { provider: string; runtime: string | null } | null;
  /** The newest run fingerprint that names a model. */
  fingerprint: { model: string; harnessVersion: string; reportedBy: string } | null;
  /** Managed skill profiles whose latest applied operation left a generation in place. */
  skills: Array<{ profile: string; releaseVersion: string | null }>;
  /** The operator's `fleet mcp-proxy` declaration; null when nobody declared. */
  mcpProxy: boolean | null;
  /** An enabled roster row on some board carries a run-scoped board-tools token. */
  boardTools: boolean;
  /** Forge API grants that are not revoked or failed. */
  forgeGrants: Array<{ provider: string; instance: string; state: string }>;
}
