/** C2, in one place: W3C headers for HTTP, `_meta` for the broker and for ACP. */
import { context, ROOT_CONTEXT, type Context } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

const w3c = new W3CTraceContextPropagator();

const recordSetter = {
  set(carrier: Record<string, string>, key: string, value: string) {
    carrier[key] = value;
  },
};
const headersGetter = {
  get(h: Headers, key: string) {
    return h.get(key) ?? undefined;
  },
  keys(h: Headers) {
    return [...h.keys()];
  },
};

// A type alias, not an interface: ACP's `_meta` is an open record, and only an alias is assignable to one.
export type TraceMeta = {
  traceparent: string;
  tracestate?: string;
};

/** The active trace as C2's `_meta` object, or null when there is none. */
export function traceMeta(ctx: Context = context.active()): TraceMeta | null {
  const carrier: Record<string, string> = {};
  w3c.inject(ctx, carrier, recordSetter);
  if (!carrier.traceparent) return null;
  return carrier.tracestate
    ? { traceparent: carrier.traceparent, tracestate: carrier.tracestate }
    : { traceparent: carrier.traceparent };
}

export function injectTraceHeaders(headers: Record<string, string>, ctx: Context = context.active()): void {
  const meta = traceMeta(ctx);
  if (!meta) return;
  headers.traceparent = meta.traceparent;
  if (meta.tracestate) headers.tracestate = meta.tracestate;
}

export function extractTraceContext(headers: Headers): Context {
  return w3c.extract(ROOT_CONTEXT, headers, headersGetter);
}

/**
 * `params._meta` for ACP `session/new` and `session/prompt` (C2). `AGENTPOD_ACP_TRACE_META=false`
 * removes it, for a harness that refuses unknown `_meta` keys.
 */
export function acpTraceMeta(env: Record<string, string | undefined> = process.env): { _meta?: TraceMeta } {
  if ((env.AGENTPOD_ACP_TRACE_META ?? "true").trim().toLowerCase() === "false") return {};
  const meta = traceMeta();
  return meta ? { _meta: { ...meta } } : {};
}
