/**
 * The hub's `dispatch`, `attempt` and `turn` spans against treaty's telemetry conventions
 * (`schemas/telemetry/suite.v1.json`, the `superwitness.telemetry` crossing): every key the
 * conventions require of a span is on it, with the type they give it. SuperWitness joins runs by
 * these keys, so a span that drops one fails here. Telemetry stays best-effort (review focus 5): a
 * missing key is this test's failure, never a refused request; `dispatch-span.test.ts` holds that
 * a broken tracer still runs the work.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { telemetryConventions, validateSpanAttributes } from "@superjackfruitlabs/treaty-contracts";
import { loadInstalledBundle } from "@superjackfruitlabs/treaty-contracts/node";
import type { AcpEvent } from "@agentpod/contract";

import { inDispatchSpan } from "./dispatch-span";
import { _setProvidersForTest, resetTelemetry } from "./otel";

const conventions = telemetryConventions(loadInstalledBundle(), "suite.v1");
const SESSION = "acps_11111111-2222-4333-8444-555555555555";

let seq = 0;
const ev = (type: AcpEvent["type"], payload: unknown): AcpEvent => ({
  sessionId: SESSION,
  seq: ++seq,
  type,
  payload,
  createdAt: new Date(Date.UTC(2026, 10, 24, 12, 0, seq)).toISOString(),
});

/** One dispatch with an attempt of two turns, its spans as the exporter got them. */
async function oneDispatch(status: string) {
  seq = 0;
  const exporter = new InMemorySpanExporter();
  _setProvidersForTest({ tracerProvider: new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }) });
  await inDispatchSpan(
    {
      runId: "run_abcdef",
      boardId: "brd_9c1d4e5f6a7b8c9d",
      cardId: "card_1a2b3c4d5e6f7a8b",
      source: "superpipeline",
      stationId: "station_1",
      startTime: new Date(Date.UTC(2026, 10, 24, 12, 0, 0)),
      runEpoch: 2,
    },
    async (spans) => {
      const prompt = ev("user-prompt", { text: "write it" });
      spans.onEvent(prompt);
      spans.openAttempt({
        attemptId: "attempt_1",
        sessionId: SESSION,
        startSeq: prompt.seq,
        fingerprintDigest: "sha256:" + "a".repeat(64),
        harnessName: "hermes",
      });
      spans.onEvent(ev("agent-update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }));
      spans.onEvent(ev("state", { status: "idle" }));
      spans.onEvent(ev("user-prompt", { text: "again" }));
      spans.onEvent(ev("error", { kind: "timeout" }));
      return { status };
    },
  );
  return exporter.getFinishedSpans();
}

afterEach(() => resetTelemetry());

describe("suite.v1: the hub's spans carry the keys SuperWitness joins by", () => {
  for (const status of ["reported", "failed"]) {
    test(`a ${status} dispatch: dispatch, attempt and every turn`, async () => {
      const spans = await oneDispatch(status);
      const names = spans.map((s) => s.name);
      expect(names.filter((n) => n === "dispatch")).toHaveLength(1);
      expect(names.filter((n) => n === "attempt")).toHaveLength(1);
      expect(names.filter((n) => n === "turn")).toHaveLength(2);
      for (const span of spans.filter((s) => s.name in conventions.spans)) {
        const result = validateSpanAttributes(conventions, span.name, span.attributes);
        expect({ span: span.name, errors: result.errors }).toEqual({ span: span.name, errors: [] });
      }
    });
  }

  test("every span the conventions say the hub produces is one it emits", async () => {
    const emitted = new Set((await oneDispatch("reported")).map((s) => s.name));
    const ours = Object.entries(conventions.spans)
      .filter(([, def]) => def.producers.includes("agentpod"))
      .map(([name]) => name);
    expect(ours.toSorted()).toEqual(["attempt", "dispatch", "turn"]);
    for (const name of ours) expect(emitted.has(name)).toBe(true);
  });

  test("a span that drops a key the conventions require fails the check", async () => {
    const attempt = (await oneDispatch("reported")).find((s) => s.name === "attempt");
    if (!attempt) throw new Error("no attempt span");
    const { "acp.seq_to": _dropped, ...rest } = attempt.attributes;
    expect(validateSpanAttributes(conventions, "attempt", rest).valid).toBe(false);
    expect(validateSpanAttributes(conventions, "attempt", { ...attempt.attributes, "acp.seq_from": "1" }).valid).toBe(false);
  });
});
