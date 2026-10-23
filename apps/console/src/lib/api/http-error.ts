/**
 * Human-readable API errors.
 *
 * Every failed hub request throws an ApiError whose `message` is written for
 * the person reading the error banner/toast — never a raw HTTP line. The
 * technical request line (`POST /api/runtimes → 500`) lives in `detail` for
 * debugging and console logs.
 */

export class ApiError extends Error {
  /** HTTP status, or null when the request never reached the hub. */
  readonly status: number | null;
  /** Technical request line, e.g. "POST /api/runtimes → 500". */
  readonly detail: string;
  /**
   * The hub's own machine-readable reason, when its JSON body carries one —
   * e.g. a declared-harness-config refusal's `UNKNOWN_SETTING`, `OPTED_OUT`,
   * `PLAN_STALE`. Undefined when the body has none; a caller that needs to
   * tell refusals apart reads this, never `message` (prose, for display
   * only, and not guaranteed stable across releases).
   */
  readonly code?: string;
  /**
   * Where the thing now lives, when the hub says it is managed elsewhere: under the org plane the
   * hub answers `410 { error: "managed_by_org_plane", url }` for users, grants and devices.
   */
  readonly url?: string;
  /** Who holds a Salaam station, on a `station_busy` refusal. */
  readonly holder?: StationBusyHolder;

  constructor(
    message: string,
    opts: { status: number | null; detail: string; code?: string; url?: string; holder?: StationBusyHolder },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = opts.status;
    this.detail = opts.detail;
    this.code = opts.code;
    this.url = opts.url;
    this.holder = opts.holder;
  }
}

/** The hub's 424 when a Salaam station already runs someone's session (one at a time). */
export const STATION_BUSY = "station_busy";
export type StationBusyHolder = import("@agentpod/contract").StationBusyHolder;

/** "14:02", or "23 Oct, 14:02" when it was not today. Local time: it is read by a person. */
function sinceTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "a while";
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

/**
 * "Asha is in a session with this agent since 14:02. It takes one at a time." — and "You are …"
 * for the caller's own session (the panel offers a link to it).
 */
export function stationBusyMessage(holder: StationBusyHolder, now = new Date()): string {
  const since = sinceTime(holder.since, now);
  if (holder.state === "stopping")
    return `${holder.you ? "Your" : `${holder.name}'s`} last session with this agent is still stopping (since ${since}). It takes one at a time; try again in a moment.`;
  return `${holder.you ? "You are" : `${holder.name} is`} in a session with this agent since ${since}. It takes one at a time.`;
}

function parseHolder(v: unknown): StationBusyHolder | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const h = v as Record<string, unknown>;
  if (typeof h.name !== "string" || typeof h.you !== "boolean" || typeof h.since !== "string") return undefined;
  return {
    name: h.name,
    you: h.you,
    since: h.since,
    state: h.state === "stopping" ? "stopping" : "active",
    ...(typeof h.sessionId === "string" ? { sessionId: h.sessionId } : {}),
  };
}

import { WORKSPACE_ADMIN_REQUIRED, WORKSPACE_ADMIN_REQUIRED_MESSAGE } from "$lib/workspace-authority";

/** The hub's 403 when Salaam's authority check refuses a session (spec 2026-10-23, C10). */
export const SALAAM_AUTHORITY_DENIED = "salaam_authority_denied";
export const SALAAM_AUTHORITY_DENIED_MESSAGE =
  "You don't have a dispatch grant for this agent, or the agent is suspended. A workspace admin can grant dispatch at the organization plane";

/** The hub's refusal for anything the organization plane now owns. */
export const MANAGED_BY_ORG_PLANE = "managed_by_org_plane";

/**
 * The plane's page for a refusal the hub answered with `managed_by_org_plane`, or null. Only an
 * http(s) URL comes back, so a page can put it in an `href` as it is.
 */
export function managedByPlaneUrl(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== MANAGED_BY_ORG_PLANE || !err.url) return null;
  try {
    const u = new URL(err.url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function copyForStatus(status: number): string {
  if (status === 400) return "The hub rejected the request.";
  if (status === 401) return "Your session has expired — sign in again.";
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "That wasn't found on the hub — it may have been removed.";
  if (status === 409) return "That conflicts with the hub's current state — refresh and try again.";
  if (status === 429) return "Too many requests — wait a moment and try again.";
  if (status >= 500) return "The hub hit an internal error. Try again in a moment.";
  return `The request failed (HTTP ${status}).`;
}

/** Capitalize and terminate a hub-supplied message so it reads as a sentence. */
function asSentence(raw: string): string {
  let cleaned = raw.replace(/^(error|apierror|forbidden|unauthorized):\s*/i, "").trim();
  if (!cleaned) return cleaned;
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (!/[.!?…]$/.test(cleaned)) cleaned += ".";
  return cleaned;
}

/**
 * Build an ApiError from a failed Response. Prefers the hub's own JSON
 * `message`/`error` field (it knows why the request failed better than the
 * status code does); falls back to status-based copy. Consumes the body.
 */
export async function apiError(res: Response, requestLine: string): Promise<ApiError> {
  const detail = `${requestLine} → ${res.status}`;
  let hubMessage: string | undefined;
  let code: string | undefined;
  let url: string | undefined;
  let holder: StationBusyHolder | undefined;
  try {
    const text = await res.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const candidate = parsed.message ?? parsed.error;
        if (typeof candidate === "string" && candidate.trim()) hubMessage = candidate;
        if (typeof parsed.code === "string" && parsed.code.trim()) code = parsed.code;
        if (parsed.error === WORKSPACE_ADMIN_REQUIRED) {
          // A member called a workspace-admin route: say who can, never the raw code.
          code = WORKSPACE_ADMIN_REQUIRED;
          hubMessage = WORKSPACE_ADMIN_REQUIRED_MESSAGE;
        }
        if (code === STATION_BUSY) {
          holder = parseHolder(parsed.holder);
          if (holder) hubMessage = stationBusyMessage(holder);
        }
        if (code === SALAAM_AUTHORITY_DENIED) {
          // The hub's sentence is for operators reading logs; say what the person can do.
          hubMessage = SALAAM_AUTHORITY_DENIED_MESSAGE;
        }
        if (parsed.error === MANAGED_BY_ORG_PLANE) {
          code = MANAGED_BY_ORG_PLANE;
          hubMessage = "This is managed in your Super Jackfruit account";
          if (typeof parsed.url === "string") url = parsed.url;
        }
      } catch {
        // Non-JSON body (HTML error page, plain text): only trust short plain
        // strings — never dump an HTML document into a toast.
        if (text.length <= 200 && !text.trimStart().startsWith("<")) hubMessage = text;
      }
    }
  } catch {
    // Body unreadable — fall through to status copy.
  }

  const message = hubMessage ? asSentence(hubMessage) : copyForStatus(res.status);
  return new ApiError(message, { status: res.status, detail, code, url, holder });
}

/** Build an ApiError for a request that never got a response (fetch threw). */
export function networkError(requestLine: string, cause: unknown): ApiError {
  const detail = `${requestLine} → ${cause instanceof Error ? cause.message : "network error"}`;
  return new ApiError("Couldn't reach the hub — check your connection.", {
    status: null,
    detail,
  });
}
