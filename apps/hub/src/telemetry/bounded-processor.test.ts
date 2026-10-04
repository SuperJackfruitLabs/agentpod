import { describe, expect, test } from "bun:test";
import { BasicTracerProvider, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { DroppingSpanProcessor } from "./bounded-processor";
import { pollUntil } from "../../tests/helpers/wait";

/** An exporter that never answers: a collector that accepted the socket and went silent. */
const hung = (): SpanExporter => ({ export: () => {}, shutdown: async () => {} });

describe("DroppingSpanProcessor", () => {
  test("drops and counts once the queue is full, and never throws", () => {
    let dropped = 0;
    const p = new DroppingSpanProcessor(hung(), {
      maxQueueSize: 3,
      onDrop: (n) => (dropped += n),
      exportTimeoutMillis: 60_000,
      scheduledDelayMillis: 60_000,
    });
    const t = new BasicTracerProvider({ spanProcessors: [p] }).getTracer("t");
    for (let i = 0; i < 5; i++) t.startSpan(`s${i}`).end();
    expect(p.queued).toBe(3);
    expect(dropped).toBe(2);
  });

  test("a hung export is released at its deadline, so the queue recovers", async () => {
    let dropped = 0;
    const p = new DroppingSpanProcessor(hung(), {
      maxQueueSize: 3,
      onDrop: (n) => (dropped += n),
      exportTimeoutMillis: 50,
      scheduledDelayMillis: 10,
    });
    const t = new BasicTracerProvider({ spanProcessors: [p] }).getTracer("t");
    for (let i = 0; i < 3; i++) t.startSpan(`s${i}`).end();
    await pollUntil(() => p.queued === 0, 2_000, 10);
    t.startSpan("after").end();
    expect(p.queued).toBe(1);
    expect(dropped).toBe(0);
  });
});
