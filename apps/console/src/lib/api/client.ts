import type { NodeSummary, DetectedStation, StationHealth, FsEntry, ProvisionedRuntime, FleetAgent, FleetStats } from "@agentpod/contract";
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

export const updateNode = (id: string) =>
  http<{ ok: boolean; updating?: boolean; tag?: string; error?: string }>(
    `/api/nodes/${id}/update`,
    { method: "POST" }
  );

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
 * Structurally mirrors the hub's `DriverManifest` without importing it — the
 * console shares only the contract package with the hub. Only the fields the
 * console renders from are required; the rest are declared optional so the hub
 * can add a field (or a whole new driver) without a console edit, which is the
 * point of the registry.
 */
export type DriverManifest = {
  provider: string;
  /** Tiers this driver can actually satisfy — the dialog builds its tier list from this. */
  supportedTiers: string[];
  workspaceStorage?: "rootfs" | "volume" | "external-archive";
  stopSemantics?: "resumable" | "terminal";
  maxLifetimeMs?: number | null;
  imageBinding?: "per-instance" | "fixed";
  idleBehaviour?: "never" | "platform-inbound" | "hub-driven";
  lifecycle?: Array<"start" | "stop" | "status">;
};

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
