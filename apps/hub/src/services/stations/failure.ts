/**
 * How the hub answers when a station or its node fails (spec 2026-10-23, C16).
 *
 * Never 502 or 504. An edge in front of the hub (Cloudflare on staging and production) replaces
 * an origin 502/504 with its own HTML page that carries no CORS headers. The console's fetch then
 * throws, and a node failure is shown as "Couldn't reach the hub". 424 and 503 pass through the
 * edge untouched, so the hub's JSON message reaches the person.
 *
 * - The node is not there to ask (offline, disconnected, timed out): 503 `station_unavailable`.
 * - The node answered and the station failed: 424 `node_failed`.
 * - The node refused a path (outside the workspace, or denied): 403 `path_refused`. A refusal,
 *   not a failure (spec 2026-10-23, C6), in the node's wording (fsops.ErrEscape, ErrDenied).
 * - The node reported the path absent (`<path>: not found`): 404 `not_found`.
 */
export type StationFailureCode = "station_unavailable" | "node_failed" | "path_refused" | "not_found";

export interface StationFailure {
  status: 403 | 404 | 424 | 503;
  body: { error: string; code: StationFailureCode };
}

// The broker's transport errors, and the session service's own wording of the first.
const TRANSPORT = new Set(["node offline", "node disconnected", "timeout", "Node is offline."]);

export function stationFailure(error: string | undefined, fallback: string): StationFailure {
  const message = error?.trim() || fallback;
  if (error && TRANSPORT.has(error)) {
    return { status: 503, body: { error: message, code: "station_unavailable" } };
  }
  if (error && (error.includes("path escapes workspace") || error.startsWith("path denied"))) {
    return { status: 403, body: { error: message, code: "path_refused" } };
  }
  if (error && error.endsWith(": not found")) {
    return { status: 404, body: { error: message, code: "not_found" } };
  }
  return { status: 424, body: { error: message, code: "node_failed" } };
}
