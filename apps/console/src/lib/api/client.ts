import type { NodeSummary, DetectedStation, StationHealth, FsEntry, ProvisionedRuntime, FleetAgent, FleetStats } from "@agentpod/contract";
import { goto } from "$app/navigation";
import { clearAuthSession } from "$lib/stores/auth.svelte";

/** Resolves the hub base URL at call time so it reflects the runtime connection. */
function hubUrl(): string {
  const stored =
    typeof window !== "undefined" ? window.localStorage.getItem("agentpod.apiUrl") : null;
  return stored ?? import.meta.env.PUBLIC_HUB_URL ?? "http://localhost:3001";
}

/**
 * Handle a 401 Unauthorized response by clearing the local auth session and
 * redirecting to /login.  Guards against redirect loops: does nothing when the
 * current path is already a public route (/login, /setup) or when running
 * server-side (typeof window === "undefined").
 */
export function handleUnauthorized(): void {
  if (
    typeof window !== "undefined" &&
    !window.location.pathname.startsWith("/login") &&
    !window.location.pathname.startsWith("/setup")
  ) {
    clearAuthSession();
    goto("/login");
  }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${hubUrl()}${path}`, { credentials: "include", ...init });
  if (res.status === 401) {
    handleUnauthorized();
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  }
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
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

export const listRuntimeProviders = () =>
  http<{ providers: string[] }>("/api/runtimes/providers");

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
  const res = await fetch(
    `${hubUrl()}/api/stations/${stationId}/file?path=${encodeURIComponent(path)}`,
    { credentials: "include" }
  );
  if (!res.ok) throw new Error(`GET /api/stations/${stationId}/file → ${res.status}`);
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
