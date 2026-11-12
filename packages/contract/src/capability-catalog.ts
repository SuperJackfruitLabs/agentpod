import { z } from "zod";

/**
 * The hub's capability catalog and per-station registry, as a service reads them (charter decision
 * 2026-11-13, AgentPod owns the capability catalog): `GET /api/catalog`, `GET /api/catalog/stations`
 * and `GET /api/catalog/stations/:id`. Names only: a credential is its name, never a value.
 */

/** What kind of thing a catalog entry is. */
export const CatalogKind = z.enum(["skill", "mcp", "cli", "harness", "service"]);
export type CatalogKind = z.infer<typeof CatalogKind>;

/**
 * How a registry fact is known, strongest first: `probed` (something checked it works),
 * `installed` (AgentPod put it there), `declared` (someone said so, and nothing has checked it).
 */
export const CatalogProof = z.enum(["probed", "installed", "declared"]);
export type CatalogProof = z.infer<typeof CatalogProof>;

/**
 * How strongly a station's harness is kept from its machine, weakest first: `host` (the node's own
 * user, no provisioned runtime), `container` (a shared kernel), `sandbox` (gVisor or a microVM).
 */
export const IsolationLevel = z.enum(["host", "container", "sandbox"]);
export type IsolationLevel = z.infer<typeof IsolationLevel>;

/** One thing that exists in the workspace. */
export const CatalogEntry = z
  .object({
    /** `<kind>:<name>`, e.g. `harness:hermes`, `skill:engineering`, `mcp:superpipeline`. */
    id: z.string().min(1),
    kind: CatalogKind,
    name: z.string().min(1),
    /** The newest version any station reported; null when none did. */
    version: z.string().nullable(),
    /** Where it comes from: `agentpod`, `supertoolkit`, `superpipeline`, `trusted-release`, `upload`. */
    source: z.string().min(1),
    /** An SPDX id when known; null means nobody has checked, not that it has none. */
    licence: z.string().nullable(),
    /** The names of the credentials it needs. */
    credentials: z.array(z.string().min(1)),
  })
  .strict();
export type CatalogEntry = z.infer<typeof CatalogEntry>;

export const StationTool = z.object({ id: z.string().min(1), proof: CatalogProof }).strict();
export type StationTool = z.infer<typeof StationTool>;

export const StationCredential = z
  .object({
    /** `forge:<provider>`: a forge the station's broker holds a grant for. */
    name: z.string().min(1),
    /** The forge instance (base URL) the grant is for. */
    instance: z.string().min(1),
    proof: CatalogProof,
  })
  .strict();
export type StationCredential = z.infer<typeof StationCredential>;

/** One station's row in the registry. */
export const StationCapabilities = z
  .object({
    stationId: z.string().min(1),
    /** The agent occupying the station; null for a station with no agent. */
    principalId: z.string().nullable(),
    harness: z.string().min(1),
    isolation: z.object({ level: IsolationLevel, runtime: z.string().nullable(), proof: CatalogProof }).strict(),
    /** The model the harness last ran with; null when no run has reported one. */
    model: z.object({ id: z.string().min(1), proof: CatalogProof }).strict().nullable(),
    tools: z.array(StationTool),
    credentials: z.array(StationCredential),
  })
  .strict();
export type StationCapabilities = z.infer<typeof StationCapabilities>;

/** `GET /api/catalog`. */
export const CatalogResponse = z.object({ entries: z.array(CatalogEntry) }).strict();
export type CatalogResponse = z.infer<typeof CatalogResponse>;

/** `GET /api/catalog/stations`; `GET /api/catalog/stations/:id` answers one `StationCapabilities`. */
export const CatalogStationsResponse = z.object({ stations: z.array(StationCapabilities) }).strict();
export type CatalogStationsResponse = z.infer<typeof CatalogStationsResponse>;
