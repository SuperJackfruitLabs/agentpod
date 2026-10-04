import { describe, expect, test } from "bun:test";
import { context, trace } from "@opentelemetry/api";
import { useTestTelemetry } from "../../tests/helpers/telemetry";
import { acpTraceMeta, extractTraceContext, injectTraceHeaders, traceMeta } from "./propagation";
import { tracer } from "./otel";

useTestTelemetry();

describe("propagation", () => {
  test("no active span: no traceparent anywhere", () => {
    expect(traceMeta()).toBeNull();
    const h: Record<string, string> = {};
    injectTraceHeaders(h);
    expect(h).toEqual({});
    expect(acpTraceMeta({})).toEqual({});
  });

  test("inside a span: W3C traceparent naming that span", () => {
    const span = tracer().startSpan("p");
    context.with(trace.setSpan(context.active(), span), () => {
      const { traceId, spanId } = span.spanContext();
      expect(traceMeta()!.traceparent).toBe(`00-${traceId}-${spanId}-01`);
      const h: Record<string, string> = {};
      injectTraceHeaders(h);
      expect(h.traceparent).toBe(`00-${traceId}-${spanId}-01`);
      expect(acpTraceMeta({})._meta!.traceparent).toBe(`00-${traceId}-${spanId}-01`);
      expect(acpTraceMeta({ AGENTPOD_ACP_TRACE_META: "false" })).toEqual({});
    });
    span.end();
  });

  test("extract reads a traceparent header", () => {
    const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const sc = trace.getSpanContext(extractTraceContext(new Headers({ traceparent: tp })))!;
    expect(sc.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(sc.spanId).toBe("b7ad6b7169203331");
    expect(sc.isRemote).toBe(true);
  });

  test("a malformed traceparent is ignored, not thrown", () => {
    expect(trace.getSpanContext(extractTraceContext(new Headers({ traceparent: "garbage" })))).toBeUndefined();
  });
});
