/**
 * Shaping the catalog and the registry from what the hub read (`facts.ts`). Pure: no database, no
 * clock, so every rule here is a unit test.
 */
import type {
  CatalogEntry,
  IsolationLevel,
  Proof,
  StationCapabilities,
  StationCredential,
  StationFacts,
  StationTool,
} from "./types";

/**
 * Runtimes behind a kernel boundary of their own: gVisor (`runsc`; Modal sandboxes run on it) and
 * microVMs (Fly Machines are Firecracker; Cloudflare containers run each in its own VM).
 */
const SANDBOX_RUNTIMES = new Set(["runsc", "modal-sandbox", "fly-machine", "cloudflare-container"]);

/** How strongly a station is isolated, by the runtime AgentPod provisioned for its node. */
export function isolationOf(runtime: StationFacts["runtime"]): StationCapabilities["isolation"] {
  if (runtime === null) return { level: "host", runtime: null, proof: "declared" };
  const name = runtime.runtime && runtime.runtime !== "" ? runtime.runtime : null;
  const level: IsolationLevel = name !== null && SANDBOX_RUNTIMES.has(name) ? "sandbox" : "container";
  return { level, runtime: name ?? runtime.provider, proof: "installed" };
}

/** A forge grant's state, as proof of what the station's broker can reach. */
export function grantProof(state: string): Proof {
  if (state === "verified") return "probed";
  if (state === "delivered") return "installed";
  return "declared";
}

const STRENGTH: Record<Proof, number> = { probed: 0, installed: 1, declared: 2 };
/** The stronger of two proofs. */
const stronger = (a: Proof, b: Proof): Proof => (STRENGTH[a] <= STRENGTH[b] ? a : b);

/** The catalog ids of the board tools and the node's MCP proxy. */
export const SUPERPIPELINE_MCP = "mcp:superpipeline";
export const AGENTPOD_MCP_PROXY = "mcp:agentpod-proxy";
/** SuperToolkit's broker CLI, and the forge API it brokers. */
export const STK_CLI = "cli:stk";
export const FORGE_API_SERVICE = "service:forge-api";

/** One station's registry row. */
export function stationCapabilities(f: StationFacts): StationCapabilities {
  const tools = new Map<string, Proof>();
  const add = (id: string, proof: Proof) => {
    const had = tools.get(id);
    tools.set(id, had ? stronger(had, proof) : proof);
  };

  add(`harness:${f.harness}`, f.fingerprint?.reportedBy === "harness" ? "probed" : "installed");
  for (const s of f.skills) add(`skill:${s.profile}`, "installed");
  if (f.boardTools) add(SUPERPIPELINE_MCP, "declared");
  if (f.mcpProxy === true) add(AGENTPOD_MCP_PROXY, "declared");

  const credentials = new Map<string, StationCredential>();
  for (const g of f.forgeGrants) {
    const proof = grantProof(g.state);
    add(STK_CLI, proof);
    add(FORGE_API_SERVICE, proof);
    const name = `forge:${g.provider}`;
    const key = `${name} ${g.instance}`;
    const had = credentials.get(key);
    credentials.set(key, { name, instance: g.instance, proof: had ? stronger(had.proof, proof) : proof });
  }

  return {
    stationId: f.stationId,
    principalId: f.principalId,
    harness: f.harness,
    isolation: isolationOf(f.runtime),
    model: f.fingerprint
      ? { id: f.fingerprint.model, proof: f.fingerprint.reportedBy === "harness" ? "probed" : "declared" }
      : null,
    tools: [...tools].map(([id, proof]): StationTool => ({ id, proof })).toSorted((a, b) => a.id.localeCompare(b.id)),
    credentials: [...credentials.values()].toSorted(
      (a, b) => a.name.localeCompare(b.name) || a.instance.localeCompare(b.instance),
    ),
  };
}

/** Licences we can state for the suite's own products; every other entry is null until checked. */
const KNOWN_LICENCES: Record<string, string> = {
  "harness:salaam": "Apache-2.0",
  [STK_CLI]: "Apache-2.0",
  [FORGE_API_SERVICE]: "Apache-2.0",
  [SUPERPIPELINE_MCP]: "MIT",
  [AGENTPOD_MCP_PROXY]: "MIT",
};

/** Is version `a` newer than `b`, by numeric dotted parts? Unparseable versions sort by text. */
function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return a > b;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** The workspace's catalog: one entry for everything some station has. */
export function catalogFrom(facts: readonly StationFacts[]): CatalogEntry[] {
  const entries = new Map<string, CatalogEntry>();
  const put = (e: Omit<CatalogEntry, "licence" | "credentials"> & { credentials?: string[] }) => {
    const had = entries.get(e.id);
    if (!had) {
      entries.set(e.id, { ...e, licence: KNOWN_LICENCES[e.id] ?? null, credentials: e.credentials ?? [] });
      return;
    }
    if (e.version !== null && (had.version === null || newer(e.version, had.version))) had.version = e.version;
    for (const c of e.credentials ?? []) if (!had.credentials.includes(c)) had.credentials.push(c);
  };

  for (const f of facts) {
    const version = f.fingerprint?.harnessVersion ? f.fingerprint.harnessVersion : null;
    put({ id: `harness:${f.harness}`, kind: "harness", name: f.harness, version, source: "agentpod" });
    for (const s of f.skills)
      put({
        id: `skill:${s.profile}`,
        kind: "skill",
        name: s.profile,
        version: s.releaseVersion,
        source: s.releaseVersion !== null ? "trusted-release" : "upload",
      });
    if (f.boardTools)
      put({ id: SUPERPIPELINE_MCP, kind: "mcp", name: "superpipeline", version: null, source: "superpipeline" });
    if (f.mcpProxy === true)
      put({ id: AGENTPOD_MCP_PROXY, kind: "mcp", name: "agentpod-proxy", version: null, source: "agentpod" });
    if (f.forgeGrants.length > 0) {
      const forges = [...new Set(f.forgeGrants.map((g) => `forge:${g.provider}`))];
      put({ id: STK_CLI, kind: "cli", name: "stk", version: null, source: "supertoolkit" });
      put({ id: FORGE_API_SERVICE, kind: "service", name: "forge-api", version: null, source: "supertoolkit", credentials: forges });
    }
  }
  for (const e of entries.values()) e.credentials.sort();
  return [...entries.values()].toSorted((a, b) => a.id.localeCompare(b.id));
}
