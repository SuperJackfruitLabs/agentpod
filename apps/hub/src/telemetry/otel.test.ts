import { afterEach, describe, expect, test } from "bun:test";
import { initTelemetry, readTelemetryConfig, shutdownTelemetry, tracer } from "./otel";

describe("readTelemetryConfig", () => {
  test("is off when no endpoint is set", () => {
    expect(readTelemetryConfig({}).endpoint).toBeNull();
  });
  test("drops a trailing slash", () => {
    expect(readTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/" }).endpoint).toBe(
      "http://127.0.0.1:4318",
    );
  });
  test("OTEL_SDK_DISABLED=true wins over an endpoint", () => {
    expect(
      readTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", OTEL_SDK_DISABLED: "true" }).endpoint,
    ).toBeNull();
  });
  test("logs follow OTEL_LOGS_EXPORTER, and the export timeout follows OTEL_EXPORTER_OTLP_TIMEOUT", () => {
    const cfg = readTelemetryConfig({ OTEL_LOGS_EXPORTER: "none", OTEL_EXPORTER_OTLP_TIMEOUT: "1000" });
    expect(cfg.logs).toBe(false);
    expect(cfg.exportTimeoutMs).toBe(1000);
    expect(readTelemetryConfig({}).logs).toBe(true);
    expect(readTelemetryConfig({}).exportTimeoutMs).toBe(10_000);
  });
});

describe("initTelemetry", () => {
  afterEach(() => shutdownTelemetry(500));

  test("returns null, and spans stay non-recording, when telemetry is off", async () => {
    expect(await initTelemetry(readTelemetryConfig({}))).toBeNull();
    const span = tracer().startSpan("x");
    expect(span.isRecording()).toBe(false);
    span.end();
  });

  test("never blocks on an unreachable collector, and shutdown keeps its deadline", async () => {
    const handle = await initTelemetry(readTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" }));
    expect(handle).not.toBeNull();
    const t0 = performance.now();
    for (let i = 0; i < 5_000; i++) tracer().startSpan(`s${i}`).end();
    expect(performance.now() - t0).toBeLessThan(2_000);
    const t1 = performance.now();
    await handle!.shutdown(500);
    expect(performance.now() - t1).toBeLessThan(1_500);
    // After shutdown the hub is back on the no-op tracer.
    expect(tracer().startSpan("y").isRecording()).toBe(false);
  });

  test("a malformed endpoint warns and leaves telemetry off instead of throwing", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await initTelemetry(readTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "127.0.0.1:4318" }))).toBeNull();
    } finally {
      console.log = orig;
    }
    expect(tracer().startSpan("x").isRecording()).toBe(false);
    expect(lines.join("\n")).toContain("telemetry");
    expect(lines.join("\n")).not.toContain("4318");
    // A later valid init is not blocked by the failed one.
    const handle = await initTelemetry(readTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" }));
    expect(handle).not.toBeNull();
  });
});
