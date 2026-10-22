import type { MiddlewareHandler } from "hono";

/**
 * The last line of defence for spec 2026-10-23 C16: the hub never sends 502 or 504.
 *
 * An edge in front of the hub replaces those with an HTML page without CORS headers, so the
 * console can only say "Couldn't reach the hub" even though the hub answered. Routes should
 * answer with `stationFailure()` themselves; anything that still sends 502/504 is rewritten here:
 * 502 → 424 `node_failed`, 504 → 503 `station_unavailable`. A JSON body keeps its message and
 * gains a `code` when it has none. Every other response passes through untouched.
 */
export const edgeSafeStatus: MiddlewareHandler = async (c, next) => {
  await next();
  const status = c.res.status;
  if (status !== 502 && status !== 504) return;
  const replacement = status === 502 ? 424 : 503;
  const code = status === 502 ? "node_failed" : "station_unavailable";
  const headers = new Headers(c.res.headers);
  let body: string;
  const text = await c.res.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      body = JSON.stringify({ ...obj, code: typeof obj.code === "string" ? obj.code : code });
    } else {
      body = JSON.stringify({ error: String(parsed), code });
    }
  } catch {
    body = JSON.stringify({ error: text.trim() || "the station failed", code });
  }
  headers.set("content-type", "application/json; charset=UTF-8");
  headers.delete("content-length");
  c.res = undefined;
  c.res = new Response(body, { status: replacement, headers });
};
