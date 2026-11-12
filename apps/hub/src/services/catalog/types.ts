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

/** What kind of thing a catalog entry is. */
export const CATALOG_KINDS = ["skill", "mcp", "cli", "harness", "service"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

/**
 * How a registry fact is known, strongest first:
 * - `probed`: something checked it works (a harness reported it in a real run, a broker grant was verified);
 * - `installed`: AgentPod put it there (adopted, provisioned, applied, delivered);
 * - `declared`: someone said so, and nothing has checked it.
 */
export const PROOFS = ["probed", "installed", "declared"] as const;
export type Proof = (typeof PROOFS)[number];

/**
 * How strongly a station's harness is kept from the machine it runs on, weakest first:
 * - `host`: on an enrolled machine as the node's own user, with no runtime AgentPod provisioned;
 * - `container`: in a container AgentPod provisioned, sharing the host's kernel;
 * - `sandbox`: behind a kernel boundary of its own (gVisor, or a microVM).
 */
export const ISOLATION_LEVELS = ["host", "container", "sandbox"] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

/** One thing that exists in the workspace. */
export interface CatalogEntry {
  /** `<kind>:<name>`, e.g. `harness:hermes`, `skill:engineering`, `mcp:superpipeline`. */
  id: string;
  kind: CatalogKind;
  name: string;
  /** The newest version seen on any station; null when none was reported. */
  version: string | null;
  /** Where it comes from: `agentpod`, `supertoolkit`, `superpipeline`, `trusted-release`, `upload`, `harness`. */
  source: string;
  /** An SPDX id when known; null means nobody has checked, not that it has none. */
  licence: string | null;
  /** The names of the credentials it needs, never the credentials. */
  credentials: string[];
}

export interface StationTool {
  /** A catalog entry's id. */
  id: string;
  proof: Proof;
}

export interface StationCredential {
  /** `forge:<provider>`: a forge the station's broker holds a grant for. */
  name: string;
  /** The forge instance (base URL) the grant is for. */
  instance: string;
  proof: Proof;
}

/** One station's row in the registry. */
export interface StationCapabilities {
  stationId: string;
  /** The agent occupying the station; null for a station with no agent. */
  principalId: string | null;
  harness: string;
  isolation: { level: IsolationLevel; runtime: string | null; proof: Proof };
  /** The model the station's harness last ran with; null when no run has reported one. */
  model: { id: string; proof: Proof } | null;
  tools: StationTool[];
  credentials: StationCredential[];
}

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
