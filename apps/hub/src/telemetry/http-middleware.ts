/**
 * One SERVER span per request, named `METHOD /route/:template`.
 *
 * Never a raw path, which would put ids into names and cardinality. Never the query
 * string, either: the Matrix homeserver authenticates appservice transactions with
 * `?access_token=…`, the same leak `redactUrlSecrets` closes in the request log.
 * The name is set after `next()`, from Hono's matched routes: the last match whose
 * method is not `ALL` (middleware registers as `ALL`).
 */
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Context as HonoContext, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { extractTraceContext } from "./propagation";
import { instruments, tracer } from "./otel";

const UNTRACED = new Set(["/health", "/api/health"]);

const ID_PARAMS: Record<string, string> = {
  externalRunId: "run.id",
  runId: "run.id",
  attemptId: "attempt.id",
};

export function routeTemplate(c: HonoContext): string | null {
  const routes = matchedRoutes(c);
  for (let i = routes.length - 1; i >= 0; i--) {
    const r = routes[i]!;
    if (r.method !== "ALL") return r.path;
  }
  return null;
}

/** A malformed escape (`%E0%A4%A`) must not throw: keep the raw segment. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Ids a route is about, read from the path at the template's param positions. */
export function idAttributesFor(template: string, path: string): Record<string, string> {
  const t = template.split("/");
  const p = path.split("/");
  const out: Record<string, string> = {};
  for (let i = 0; i < t.length && i < p.length; i++) {
    const seg = t[i]!;
    if (!seg.startsWith(":")) continue;
    const name = seg.slice(1).replace(/\{.*\}$/, "").replace(/\?$/, "");
    const attr = ID_PARAMS[name];
    if (attr && p[i]) out[attr] = safeDecode(p[i]!);
  }
  return out;
}

export function httpServerSpans(): MiddlewareHandler {
  return async (c, next) => {
    if (UNTRACED.has(c.req.path)) return next();
    const method = c.req.method;
    const parent = extractTraceContext(c.req.raw.headers);
    const span = tracer().startSpan(
      method,
      { kind: SpanKind.SERVER, attributes: { "http.request.method": method } },
      parent,
    );
    const started = performance.now();
    let threw = false;
    try {
      await context.with(trace.setSpan(parent, span), next);
    } catch (err) {
      threw = true;
      throw err;
    } finally {
      // Telemetry never replaces the response or the original error, and always ends the span.
      let route: string | null = null;
      let status = 500;
      try {
        route = routeTemplate(c);
        status = threw ? 500 : c.res.status;
        if (route) {
          span.updateName(`${method} ${route}`);
          span.setAttribute("http.route", route);
          span.setAttributes(idAttributesFor(route, c.req.path));
        }
        span.setAttribute("http.response.status_code", status);
        if (status >= 500) {
          span.setAttribute("error.type", String(status));
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
      } catch {
        // dropped on purpose
      }
      try {
        span.end();
      } catch {
        // dropped on purpose
      }
      try {
        instruments().httpDuration.record((performance.now() - started) / 1000, {
          "http.request.method": method,
          "http.route": route ?? "unmatched",
          "http.response.status_code": status,
        });
      } catch {
        // dropped on purpose
      }
    }
  };
}
