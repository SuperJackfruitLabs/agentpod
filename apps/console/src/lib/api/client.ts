import type { NodeSummary, DetectedStation, StationHealth, FsEntry, ProvisionedRuntime, RuntimeProviderManifest, FleetAgent, FleetStats, SkillInventory, RemoveNodeResponse } from "@agentpod/contract";
import { goto } from "$app/navigation";
import { clearAuthSession, currentPlane, getToken, planeSessionLost } from "$lib/stores/auth.svelte";
import { apiError, networkError } from "./http-error";

/** Resolves the hub base URL at call time so it reflects the runtime connection. */
export function hubUrl(): string {
  const stored =
    typeof window !== "undefined" ? window.localStorage.getItem("agentpod.apiUrl") : null;
  return stored ?? import.meta.env.PUBLIC_HUB_URL ?? "http://localhost:3001";
}

/** The plane token each response's request carried (null: none), for `handleUnauthorized`. */
const sentWith = new WeakMap<Response, string | null>();

/**
 * Handle a 401 Unauthorized response.
 *
 * Under the organization plane a 401 is not a sign-out: the token the hub refused is dropped and
 * the layout's guard re-authorizes, silently while the plane's session is alive. Going to /login
 * here (and forgetting the plane) put the operator on the login screen while still signed in at
 * the plane (2026-10-07).
 *
 * Legacy: clear the local auth session and redirect to /login. Guards against redirect loops:
 * does nothing when the current path is already a public route (/login) or when running
 * server-side (typeof window === "undefined").
 */
export function handleUnauthorized(res?: Response): void {
  if (typeof window !== "undefined" && currentPlane()) {
    planeSessionLost(res ? (sentWith.get(res) ?? null) : null);
    return;
  }
  if (
    typeof window !== "undefined" &&
    !window.location.pathname.startsWith("/login")
  ) {
    clearAuthSession();
    goto("/login");
  }
}

/**
 * How long a token handed to a WebSocket or EventSource must still have to live. The hub
 * authenticates the upgrade only, so the token just has to survive the dial — with margin for a
 * slow network — but the 30 s floor ordinary fetches use is too thin for that.
 */
export const SOCKET_MIN_VALIDITY_SEC = 60;

/**
 * Every hub request goes through here. Under the org plane the console holds a bearer token and
 * sends it, with no cookie; in legacy mode (no token) it is today's `credentials: "include"` on the
 * Better Auth session cookie, unchanged.
 */
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  if (!token) {
    const res = await fetch(url, { credentials: "include", ...init });
    remember(res, null);
    return res;
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers, credentials: "omit" });
  remember(res, token);
  return res;
}

function remember(res: Response, token: string | null): void {
  if (res && typeof res === "object") sentWith.set(res, token);
}

/**
 * WebSocket and EventSource cannot send headers; the hub's auth middleware reads `?token=` for
 * them. Appends it (URL-encoded) only when there is a token.
 */
export function withToken(url: string, token: string | null): string {
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

/**
 * The token for a socket or stream about to be opened. Legacy mode answers `null` at once — not a
 * promise — so legacy sockets open synchronously exactly as before. Under the plane it is a token
 * refreshed if it has under `SOCKET_MIN_VALIDITY_SEC` left: a tab left open past the token's
 * five-minute life still dials with a live one.
 */
export function socketToken(): Promise<string | null> | null {
  return currentPlane() ? getToken(SOCKET_MIN_VALIDITY_SEC) : null;
}

export async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const requestLine = `${init?.method ?? "GET"} ${path}`;
  let res: Response;
  try {
    res = await authFetch(`${hubUrl()}${path}`, init);
  } catch (err) {
    throw networkError(requestLine, err);
  }
  if (res.status === 401) {
    handleUnauthorized(res);
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

/**
 * Remove a node from the fleet (DELETE /api/nodes/:id). Its stations are
 * unregistered and its credential revoked, so the machine has to be enrolled
 * again with a fresh invite. The hub refuses a connected node unless `force`
 * says the caller accepts disconnecting it; a provisioned runtime's node is
 * always refused (destroy the runtime instead).
 */
export const removeNode = (id: string, opts: { force: boolean }) =>
  http<RemoveNodeResponse>(`/api/nodes/${encodeURIComponent(id)}${opts.force ? "?force=1" : ""}`, {
    method: "DELETE",
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
   * What the appservice minted for this station — never re-derived here, only
   * read, and for a harness-mode station **not** the address it is moving
   * toward.
   *
   * This used to say `matrixId <> bridgeMatrixId` was the fleet's signal that
   * a station runs under a retired identity. It is not: `provision.ts` fills
   * the column from `names.ts`'s `stationSpeaker`, which for a harness station
   * answers the harness's OWN mxid — so on the fleet the two columns agree,
   * both holding the retired station-derived address, and everything that
   * compared them read "converged" for exactly the 14 stations that had not
   * moved. Whether a station is on its principal's address is a question about
   * the agent's HANDLE, which the browser cannot derive; ask the hub
   * (`stationMoveState` below).
   */
  bridgeMatrixId: string | null;
  /**
   * Who answers for this station on Matrix — `bridge` (the appservice speaks
   * for it) or `harness` (it runs its own client). The hub has always sent it;
   * it was simply never typed here, so the console inferred the answer from a
   * null `matrixId` instead of reading it.
   */
  matrixIdentityMode: "bridge" | "harness";
  /**
   * What this agent is FOR — the operator's word, not where it runs. Null when
   * nobody has said, which files it under no Matrix space at all and leaves it
   * in All rooms.
   */
  purpose: string | null;
  /**
   * The agent occupying this station, or null.
   *
   * The hub's row already carries this (`stations.principal_id`); it was just
   * never typed here. Null is not an unhealthy station — it is a station
   * dispatchable by nobody, which is a real and legitimate state the console
   * must be able to tell apart from "assigned and running".
   */
  principalId: string | null;
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

/**
 * The operator's half of moving a harness-mode station off a retired identity
 * and onto its own, principal-derived one (`matrix/authorize-move` on the
 * hub). Puts the new identity in the station's room, mints a single-use
 * authorization, and signals the node — fire-and-forget on the hub's side, so
 * this call resolving is not convergence. There is no token in the response
 * by design: the node redeems the authorization on its own long-term
 * credential, never one that passed through this browser.
 *
 * Refusals carry the hub's own sentence (a 403 names which grant refused, a
 * 409 names the harness with no writer) — `http()` surfaces it verbatim as
 * `Error.message`, so callers must not replace it with a generic string.
 */
export const authorizeMove = (stationId: string) =>
  http<{ expiresAt: string }>(`/api/stations/${stationId}/matrix/authorize-move`, {
    method: "POST",
  });

/**
 * Where the HUB says a station stands in the §1 invariant.
 *
 * **Only one of these states is derivable in the browser** — `bridge`, which
 * is `matrixId === null` and nothing else. Every other one turns on the
 * address the station's occupying principal's HANDLE implies, and the console
 * holds neither the handle nor the homeserver domain to build it. The panel
 * used to derive three of them by comparing `matrixId` with `bridgeMatrixId`,
 * which answers a different question and answered it wrong for every station
 * on the fleet (see `StationRow.bridgeMatrixId`).
 *
 * `waiting` was never derivable at all: an authorization record lives only in
 * the hub, so a component-local flag died on reload and the one state §6 asks
 * an operator to WATCH was the one a refresh threw away.
 *
 * `converged` means the station answers as its principal's address, and
 * nothing more. It is not a health check, and nothing in this payload is one:
 * whether a station's identity can actually post in its room is a Matrix fact
 * in no column at all, and the hub's gate sweep is what checks it.
 */
export type StationMoveState =
  | { status: "unknown" }
  | { status: "bridge" }
  | { status: "converged"; mxid: string }
  /**
   * Harness mode, nobody occupying the station: no handle, so no address to
   * move to and no move to offer. Not `converged`, and not a blank.
   */
  | { status: "no-agent"; runningAs: string }
  | { status: "waiting"; runningAs: string; willBecome: string; since: string }
  | { status: "retired-identity"; runningAs: string; willBecome: string };

export const stationMoveState = (stationId: string) =>
  http<StationMoveState>(`/api/stations/${stationId}/matrix/move-state`);

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
    res = await authFetch(
      `${hubUrl()}/api/stations/${stationId}/file?path=${encodeURIComponent(path)}`
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

/** The hub's ceiling on one file read — enough for an agent's ~2 MB pfp.png. */
export const IMAGE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Read an image for preview, as a Blob. A plain `readFile` decodes the body as
 * text, which mangles binary, and stops at the node's 1 MiB default.
 */
export async function readImage(
  stationId: string,
  path: string
): Promise<{ blob: Blob; truncated: boolean }> {
  const requestLine = `GET /api/stations/${stationId}/file`;
  let res: Response;
  try {
    res = await authFetch(
      `${hubUrl()}/api/stations/${stationId}/file?path=${encodeURIComponent(path)}&maxBytes=${IMAGE_PREVIEW_MAX_BYTES}`
    );
  } catch (err) {
    throw networkError(requestLine, err);
  }
  if (!res.ok) throw await apiError(res, requestLine);
  return {
    blob: await res.blob(),
    truncated: res.headers.get("X-Truncated") === "true",
  };
}

/**
 * A file's exact bytes, up to the hub's 8 MiB ceiling on one read: binary-safe (never decoded as
 * text). `truncated` says the node cut it at the ceiling. The person reading their own station.
 */
export async function readFileBytes(
  stationId: string,
  path: string
): Promise<{ bytes: ArrayBuffer; truncated: boolean }> {
  const requestLine = `GET /api/stations/${stationId}/file`;
  let res: Response;
  try {
    res = await authFetch(
      `${hubUrl()}/api/stations/${stationId}/file?path=${encodeURIComponent(path)}&maxBytes=${IMAGE_PREVIEW_MAX_BYTES}`
    );
  } catch (err) {
    throw networkError(requestLine, err);
  }
  if (res.status === 401) {
    handleUnauthorized(res);
    throw await apiError(res, requestLine);
  }
  if (!res.ok) throw await apiError(res, requestLine);
  return {
    bytes: await res.arrayBuffer(),
    truncated: res.headers.get("X-Truncated") === "true",
  };
}

/**
 * Make a workspace image the station's Matrix profile picture. The hub routes
 * it: a harness-mode agent's node uploads it with the agent's own login, a
 * bridge-mode agent's appservice identity is set by the hub.
 */
export const setMatrixAvatar = (stationId: string, path: string) =>
  http<{ matrixId: string; mxc: string }>(`/api/stations/${encodeURIComponent(stationId)}/matrix-avatar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });

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

// Station-local skill observations, independently of runtime health.
export type SkillInventoryResult = SkillInventory;
export const skillsInventory = (stationId: string) =>
  http<SkillInventoryResult>(`/api/stations/${stationId}/skills/inventory`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
