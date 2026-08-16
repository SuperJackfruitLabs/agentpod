import type { NodeSummary, DetectedStation, StationHealth, FsEntry, ProvisionedRuntime, RuntimeProviderManifest, FleetAgent, FleetStats } from "@agentpod/contract";
import { goto } from "$app/navigation";
import { clearAuthSession } from "$lib/stores/auth.svelte";
import { apiError, networkError } from "./http-error";

/** Resolves the hub base URL at call time so it reflects the runtime connection. */
function hubUrl(): string {
  const stored =
    typeof window !== "undefined" ? window.localStorage.getItem("agentpod.apiUrl") : null;
  return stored ?? import.meta.env.PUBLIC_HUB_URL ?? "http://localhost:3001";
}

/**
 * Handle a 401 Unauthorized response by clearing the local auth session and
 * redirecting to /login.  Guards against redirect loops: does nothing when the
 * current path is already a public route (/login) or when running
 * server-side (typeof window === "undefined").
 */
export function handleUnauthorized(): void {
  if (
    typeof window !== "undefined" &&
    !window.location.pathname.startsWith("/login")
  ) {
    clearAuthSession();
    goto("/login");
  }
}

export async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const requestLine = `${init?.method ?? "GET"} ${path}`;
  let res: Response;
  try {
    res = await fetch(`${hubUrl()}${path}`, { credentials: "include", ...init });
  } catch (err) {
    throw networkError(requestLine, err);
  }
  if (res.status === 401) {
    handleUnauthorized();
    throw await apiError(res, requestLine);
  }
  if (!res.ok) throw await apiError(res, requestLine);
  // 204 No Content (and other empty bodies, e.g. DELETE/start/stop) have nothing
  // to parse — calling res.json() on them throws "Unexpected end of JSON input".
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ─── Fleet aggregate endpoints ────────────────────────────────────────────────

export const getFleet = () =>
  http<{ stats: FleetStats; agents: FleetAgent[] }>("/api/fleet/agents");

// ─── Node endpoints ───────────────────────────────────────────────────────────

export const listNodes = () => http<NodeSummary[]>("/api/nodes");

/**
 * Ask a node to self-update.
 *
 * `updating` is the load-bearing field: false means the node was already on
 * the latest release and did NOT restart, so the caller must stop showing
 * "updating…" and say so instead. A node-side failure is a non-2xx and throws
 * an ApiError carrying the node's own message (issue #296).
 *
 * `force` re-applies the current release — the escape hatch for a node whose
 * binary is corrupt but whose reported version is current.
 */
/**
 * Update the whole fleet, one node at a time, from the hub (issue #295).
 *
 * Always resolves on a reachable hub: the response carries a row per node,
 * including the ones it declined to touch and why. A node that failed is a row
 * with `outcome: "failed"`, not a thrown error — one unreachable machine must
 * not read as "the rollout failed".
 */
export const updateAllNodes = (opts?: { force?: boolean; only?: string[] }) =>
  http<{
    ok: boolean;
    summary: Record<string, number>;
    results: Array<{
      nodeId: string;
      name: string;
      outcome: "updated" | "no-op" | "skipped" | "failed";
      tag?: string;
      reason?: string;
      error?: string;
    }>;
  }>("/api/nodes/update-all", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ force: opts?.force ?? false, ...(opts?.only ? { only: opts.only } : {}) }),
  });

export const updateNode = (id: string, opts?: { force?: boolean }) =>
  http<{
    ok: boolean;
    updating?: boolean;
    tag?: string;
    currentVersion?: string;
    reason?: string;
    error?: string;
  }>(`/api/nodes/${id}/update${opts?.force ? "?force=1" : ""}`, {
    method: "POST",
  });

// ─── Runtime endpoints ────────────────────────────────────────────────────────

export const provisionRuntime = (req: {
  provider: string;
  name: string;
  resourceTier: string;
  harness?: string;
}) =>
  http<ProvisionedRuntime>("/api/runtimes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, harness: req.harness ?? "none" }),
  });

export const listRuntimes = () => http<ProvisionedRuntime[]>("/api/runtimes");

/**
 * What a provisioner driver declares about its substrate, as reported by the
 * hub's driver registry.
 *
 * The shape now lives in the contract — the one package the console and the hub
 * share — rather than being mirrored structurally here. It moved there when it
 * grew `harnessTiers`: which (harness, tier) pairs are viable is a fact the two
 * sides have to agree on, and "two structurally similar types that happen to
 * agree" is precisely what let the console offer fly+opencode+small (#279).
 * Everything but `provider` and `supportedTiers` stays optional there, so a hub
 * that predates a field cannot blank the dialog.
 */
export type DriverManifest = RuntimeProviderManifest;

export const listRuntimeProviders = () =>
  http<{
    providers: string[];
    /** One manifest per enabled provider — the dialog builds its form from these. */
    manifests?: DriverManifest[];
  }>("/api/runtimes/providers");

export const destroyRuntime = (id: string) =>
  http<void>(`/api/runtimes/${id}`, { method: "DELETE" });

export const startRuntime = (id: string) =>
  http<void>(`/api/runtimes/${id}/start`, { method: "POST" });

export const stopRuntime = (id: string) =>
  http<void>(`/api/runtimes/${id}/stop`, { method: "POST" });
export const createEnrollmentToken = () =>
  http<{ token: string; expiresAt: string }>("/api/enrollment-tokens", { method: "POST" });

// ─── Station row type (hub DB shape returned by listStations / adoptStations) ─

export type StationRow = {
  id: string;
  userId: string;
  nodeId: string;
  harness: string;
  stationKey: string;
  kind: string;
  parentStationId: string | null;
  displayName: string;
  workspacePath: string | null;
  capabilities: string[] | null;
  matrixId: string | null;
  /**
   * What this agent is FOR — the operator's word, not where it runs. Null when
   * nobody has said, which files it under no Matrix space at all and leaves it
   * in All rooms.
   */
  purpose: string | null;
  adoptedAt: string | Date;
  createdAt: string | Date;
};

// ─── Station endpoints ────────────────────────────────────────────────────────

export const listDetected = (nodeId: string) =>
  http<DetectedStation[]>(`/api/nodes/${nodeId}/detected`);

export const adoptStations = (nodeId: string, keys: string[]) =>
  http<StationRow[]>(`/api/nodes/${nodeId}/stations/adopt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys }),
  });

export const listStations = (nodeId: string) =>
  http<StationRow[]>(`/api/nodes/${nodeId}/stations`);

/**
 * Set what an agent is for. `null` unlabels it.
 *
 * The room moves to match: the hub re-files it under that purpose's Matrix
 * space, which is how a roster of a hundred agents stays readable.
 */
export const setStationPurpose = (stationId: string, purpose: string | null) =>
  http<{ id: string; purpose: string | null }>(`/api/stations/${stationId}/purpose`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purpose }),
  });

/**
 * Set the purpose a node's future adoptions inherit, and label the agents
 * already on it that have none. `stationsLabelled` says how many that was —
 * this endpoint touches rows the caller did not name.
 */
export const setNodePurpose = (nodeId: string, purpose: string | null) =>
  http<{ id: string; purpose: string | null; stationsLabelled: number }>(
    `/api/nodes/${nodeId}/purpose`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purpose }),
    }
  );

export const stationHealth = (stationId: string) =>
  http<StationHealth>(`/api/stations/${stationId}/health`);

export const listFiles = (stationId: string, path: string) =>
  http<FsEntry[]>(`/api/stations/${stationId}/files?path=${encodeURIComponent(path)}`);

export async function readFile(
  stationId: string,
  path: string
): Promise<{ content: string; truncated: boolean }> {
  const requestLine = `GET /api/stations/${stationId}/file`;
  let res: Response;
  try {
    res = await fetch(
      `${hubUrl()}/api/stations/${stationId}/file?path=${encodeURIComponent(path)}`,
      { credentials: "include" }
    );
  } catch (err) {
    throw networkError(requestLine, err);
  }
  if (!res.ok) throw await apiError(res, requestLine);
  return {
    content: await res.text(),
    truncated: res.headers.get("X-Truncated") === "true",
  };
}

export const logsUrl = (stationId: string) =>
  `${hubUrl()}/api/stations/${stationId}/logs`;

// ─── Station write endpoints ──────────────────────────────────────────────────

export const writeFile = (
  stationId: string,
  path: string,
  content: string,
  opts?: { backup?: boolean; encoding?: "utf8" | "base64" }
) =>
  http<{ bytesWritten: number; backupPath?: string | null }>(
    `/api/stations/${stationId}/fs/write`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path,
        content,
        encoding: opts?.encoding ?? "utf8",
        ...(opts?.backup !== undefined ? { backup: opts.backup } : {}),
      }),
    }
  );

export const mkdir = (stationId: string, path: string) =>
  http<{ ok: boolean }>(`/api/stations/${stationId}/fs/mkdir`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

export const move = (stationId: string, from: string, to: string) =>
  http<{ ok: boolean }>(`/api/stations/${stationId}/fs/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });

export const del = (stationId: string, path: string, opts?: { recursive?: boolean }) =>
  http<{ ok: boolean }>(`/api/stations/${stationId}/fs/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, ...(opts?.recursive !== undefined ? { recursive: opts.recursive } : {}) }),
  });

export const lifecycle = (stationId: string, action: "start" | "stop" | "restart") =>
  http<StationHealth>(`/api/stations/${stationId}/lifecycle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });

// ─── Activity / audit-log endpoints ──────────────────────────────────────────

export type StationAuditRow = {
  id: string;
  userId: string;
  nodeId: string;
  stationKey: string;
  verb: string;
  // jsonb object from the hub (apps/hub/src/db/schema/audit.ts); string kept
  // for backward compatibility with older rows.
  paramsSummary: Record<string, unknown> | string | null;
  result: string;
  error: string | null;
  createdAt: string | Date;
};

export const activity = (stationId: string) =>
  http<StationAuditRow[]>(`/api/stations/${stationId}/activity`);

// ─── Fleet activity endpoints ─────────────────────────────────────────────────

export interface AuditRow {
  id: string;
  stationKey: string;
  verb: string;
  result: string;
  paramsSummary?: unknown;
  createdAt: string;
}

export const listFleetActivity = () => http<AuditRow[]>("/api/activity");

/** Minimal shape returned by GET /api/activity (fleet-wide audit rows). */
export type ActivityRow = {
  id: string;
  verb: string;
  stationKey?: string;
  nodeId?: string;
  result?: string;
  createdAt: string;
};

export const listActivity = () => http<ActivityRow[]>("/api/activity");

// ─── Cleanup endpoints ────────────────────────────────────────────────────────

export type CleanupItem = { path: string; size: number; kind: string };

export const cleanupPlan = (stationId: string) =>
  http<{ items: CleanupItem[]; totalBytes: number }>(
    `/api/stations/${stationId}/cleanup/plan`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
  );

export const cleanupApply = (stationId: string, paths: string[]) =>
  http<{ removedBytes: number }>(`/api/stations/${stationId}/cleanup/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });

// ─── Changeset endpoints ──────────────────────────────────────────────────────

export type ChangesetFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "untracked";

export type ChangesetFile = {
  path: string;
  /** Set for renames and copies only. */
  oldPath: string | null;
  status: ChangesetFileStatus;
  /** Null for binary files and for untracked files, which git will not count
   *  without `git add -N` — and that would mutate a live workspace's index. */
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
};

export type ChangesetCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  committedAt: string;
};

export type ChangesetStatusResult = {
  repo: { branch: string | null; head: string | null; detached: boolean };
  base: {
    ref: string;
    sha: string;
    reason: "explicit" | "upstream" | "default-branch" | "head";
  };
  uncommitted: { files: ChangesetFile[]; insertions: number; deletions: number };
  committed: {
    files: ChangesetFile[];
    insertions: number;
    deletions: number;
    commits: ChangesetCommit[];
  };
  truncatedFiles: boolean;
};

export type ChangesetDiffResult = { content: string; truncated: boolean; binary: boolean };

export const changesetStatus = (stationId: string, base?: string) =>
  http<ChangesetStatusResult>(`/api/stations/${stationId}/changeset/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(base ? { base } : {}),
  });

export const changesetDiff = (
  stationId: string,
  side: "uncommitted" | "committed",
  path?: string
) =>
  http<ChangesetDiffResult>(`/api/stations/${stationId}/changeset/diff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ side, ...(path ? { path } : {}) }),
  });

// ─── Posture endpoints ────────────────────────────────────────────────────────

export type PostureFindingRow = {
  check: string;
  status: "pass" | "fail" | "unknown";
  severity: "critical" | "warning" | "info";
  harness?: string;
  /** Station key (e.g. `hermes:analyst-echo`) for per-station findings. */
  station?: string;
  title: string;
  detail: string;
  path?: string;
  remedy?: string;
};

export type PostureReportResult = {
  hostname: string;
  stations: number;
  findings: PostureFindingRow[];
  /** A — nothing · B — info only · C — a warning · F — a critical. */
  grade: string;
};

export const nodePosture = (nodeId: string) =>
  http<PostureReportResult>(`/api/nodes/${nodeId}/posture/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
