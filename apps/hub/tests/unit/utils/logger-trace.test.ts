import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { context, trace } from "@opentelemetry/api";
import { createLogger } from "../../../src/utils/logger";
import { tracer } from "../../../src/telemetry/otel";
import { useTestTelemetry } from "../../helpers/telemetry";

const t = useTestTelemetry();

describe("logger and traces", () => {
  const out = spyOn(console, "log").mockImplementation(() => {});
  afterEach(() => out.mockClear());
  afterAll(() => out.mockRestore()); // every hub test file shares one process

  test("a line written inside a span carries trace_id and span_id", () => {
    const span = tracer().startSpan("dispatch");
    context.with(trace.setSpan(context.active(), span), () => createLogger("bridge").info("claimed", { n: 1 }));
    span.end();
    const line = JSON.parse(out.mock.calls.at(-1)![0] as string);
    expect(line.trace_id).toBe(span.spanContext().traceId);
    expect(line.span_id).toBe(span.spanContext().spanId);
    expect(line.message).toBe("claimed");
  });

  test("a line written outside any span has no trace fields", () => {
    createLogger("x").info("idle");
    const line = JSON.parse(out.mock.calls.at(-1)![0] as string);
    expect("trace_id" in line).toBe(false);
  });

  test("with a log provider installed, the line is also an OTLP record bound to the span", () => {
    const span = tracer().startSpan("dispatch");
    context.with(trace.setSpan(context.active(), span), () =>
      createLogger("bridge").warn("backing off", { run: "run_1", nested: { a: 1 } }),
    );
    span.end();
    const rec = t.logs().at(-1)!;
    expect(rec.body).toBe("backing off");
    expect(rec.severityText).toBe("WARN");
    expect(rec.attributes).toMatchObject({ component: "bridge", run: "run_1" });
    expect("nested" in rec.attributes).toBe(false);
    expect(rec.spanContext?.traceId).toBe(span.spanContext().traceId);
  });
});
