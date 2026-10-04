import { afterEach, describe, expect, test } from "bun:test";
import type { TracerProvider } from "@opentelemetry/api";
import { inDispatchSpan } from "./dispatch-span";
import { _setProvidersForTest, resetTelemetry } from "./otel";

const input = { runId: "r", boardId: "b", cardId: "c", source: "superpipeline", stationId: "s", startTime: new Date() };

describe("inDispatchSpan", () => {
  afterEach(() => resetTelemetry());

  test("a throw while starting the span still runs the work, without telemetry", async () => {
    const broken = {
      getTracer: () => ({
        startSpan: () => {
          throw new Error("exporter exploded");
        },
        startActiveSpan: () => {
          throw new Error("exporter exploded");
        },
      }),
    } as unknown as TracerProvider;
    _setProvidersForTest({ tracerProvider: broken });
    let ran = false;
    const result = await inDispatchSpan(input, async (spans) => {
      ran = true;
      spans.onEvent({ sessionId: "x", seq: 1, type: "state", payload: {}, createdAt: new Date().toISOString() } as never);
      return { status: "idle" } as never;
    });
    expect(ran).toBe(true);
    expect(result).toEqual({ status: "idle" } as never);
  });
});
