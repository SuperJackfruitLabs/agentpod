import { describe, expect, test } from "bun:test";
import { ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { AcpEvent } from "@agentpod/contract";
import { AgentSpanRecorder, type AttemptFacts } from "./agent-spans";

const MARKER = "CANARY-MARKER-7f3a9c";
const SESSION = "acps_11111111-2222-4333-8444-555555555555";

function rig(maxBuffered?: number) {
  const exporter = new InMemorySpanExporter();
  const tracer = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).getTracer("t");
  const parentSpan = tracer.startSpan("dispatch");
  const rec = new AgentSpanRecorder({
    tracer,
    parent: trace.setSpan(ROOT_CONTEXT, parentSpan),
    stationId: "st_1",
    runId: "run_1",
    ...(maxBuffered ? { maxBuffered } : {}),
  });
  const named = (n: string) => exporter.getFinishedSpans().filter((s) => s.name === n);
  return { rec, exporter, parentSpan, named };
}

let seq = 0;
const ev = (type: AcpEvent["type"], payload: unknown): AcpEvent => ({
  sessionId: SESSION,
  seq: ++seq,
  type,
  payload,
  createdAt: new Date(Date.UTC(2026, 9, 4, 12, 0, seq)).toISOString(),
});

const facts = (startSeq: number): AttemptFacts => ({
  attemptId: "attempt_1",
  sessionId: SESSION,
  startSeq,
  fingerprintDigest: "sha256:" + "a".repeat(64),
  harnessName: "hermes",
});

describe("AgentSpanRecorder", () => {
  test("builds attempt > turn > tool_call/permission with C1 attributes and no content", () => {
    seq = 0;
    const { rec, exporter, parentSpan, named } = rig();
    const prompt = ev("user-prompt", { text: `Please ${MARKER}` });
    rec.onEvent(prompt);
    rec.onEvent(ev("state", { status: "working" }));
    rec.openAttempt(facts(prompt.seq));
    rec.onEvent(ev("agent-update", {
      sessionUpdate: "tool_call", toolCallId: "t1", kind: "execute", status: "pending",
      title: `rm ${MARKER}`, rawInput: { cmd: MARKER },
    }));
    rec.onEvent(ev("agent-update", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: MARKER }));
    rec.onEvent(ev("agent-update", { sessionUpdate: "tool_call", toolCallId: "t2", kind: `curl ${MARKER}`, status: "failed" }));
    const req = ev("permission-request", {
      toolCall: { title: `edit ${MARKER}`, kind: "edit" },
      options: [{ optionId: "ok", kind: "allow_once", name: MARKER }, { optionId: "no", kind: "reject_once", name: "No" }],
    });
    rec.onEvent(req);
    rec.onEvent(ev("permission-answer", { requestSeq: req.seq, optionId: "ok" }));
    rec.onEvent(ev("agent-update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: MARKER } }));
    rec.onEvent(ev("error", { kind: "quota", message: `quota ${MARKER}` }));
    const idle = ev("state", { status: "idle" });
    rec.onEvent(idle);
    rec.end("completed");
    parentSpan.end();

    const [attempt] = named("attempt");
    const [turn] = named("turn");
    const tools = named("tool_call");
    const [permission] = named("permission");

    expect(attempt!.parentSpanContext?.spanId).toBe(parentSpan.spanContext().spanId);
    expect(attempt!.attributes).toMatchObject({
      "attempt.id": "attempt_1", "station.id": "st_1", "fingerprint.digest": "sha256:" + "a".repeat(64),
      "harness.name": "hermes", "acp.session_id": SESSION, "acp.seq_from": prompt.seq, "run.id": "run_1",
      "attempt.state": "completed",
    });
    expect(attempt!.startTime).toEqual(turn!.startTime);

    expect(turn!.parentSpanContext?.spanId).toBe(attempt!.spanContext().spanId);
    expect(turn!.attributes).toMatchObject({ "attempt.id": "attempt_1", "acp.seq_from": prompt.seq, "acp.seq_to": idle.seq, "error.type": "quota" });
    expect(turn!.status.code).toBe(SpanStatusCode.ERROR);

    const t1 = tools.find((s) => s.attributes["tool.kind"] === "execute")!;
    expect(t1.parentSpanContext?.spanId).toBe(turn!.spanContext().spanId);
    expect(t1.attributes).toMatchObject({ "tool.status": "completed", "acp.seq_from": 3, "acp.seq_to": 4 });
    const t2 = tools.find((s) => s !== t1)!;
    expect(t2.attributes["tool.kind"]).toBe("other");
    expect(t2.attributes["tool.status"]).toBe("failed");

    expect(permission!.attributes).toMatchObject({ "attempt.id": "attempt_1", "permission.outcome": "allow_once", "tool.kind": "edit" });

    const dump = JSON.stringify(exporter.getFinishedSpans().map((s) => [s.name, s.attributes, s.events, s.status, s.links]));
    expect(dump).not.toContain(MARKER);
  });

  test("closes what is still open at end: tools with their last status, permissions as unanswered", () => {
    seq = 0;
    const { rec, named } = rig();
    rec.openAttempt(facts(1));
    rec.onEvent(ev("agent-update", { sessionUpdate: "tool_call", toolCallId: "t", kind: "read", status: "in_progress" }));
    rec.onEvent(ev("permission-request", { toolCall: { kind: "execute" }, options: [] }));
    rec.end("failed");
    expect(named("tool_call")[0]!.attributes["tool.status"]).toBe("in_progress");
    expect(named("permission")[0]!.attributes["permission.outcome"]).toBe("unanswered");
    expect(named("attempt")[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(named("turn")).toHaveLength(1);
  });

  test("an attempt that never opened emits nothing", () => {
    seq = 0;
    const { rec, exporter } = rig();
    rec.onEvent(ev("user-prompt", { text: "x" }));
    rec.end("failed");
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  test("the pre-open buffer is bounded and counts what it dropped", () => {
    seq = 0;
    const { rec } = rig(2);
    for (let i = 0; i < 3; i++) rec.onEvent(ev("agent-update", { sessionUpdate: "agent_message_chunk" }));
    expect(rec.droppedEvents).toBe(1);
  });

  test("events after end are ignored", () => {
    seq = 0;
    const { rec, exporter } = rig();
    rec.openAttempt(facts(1));
    rec.end("completed");
    const n = exporter.getFinishedSpans().length;
    rec.onEvent(ev("user-prompt", { text: "late" }));
    rec.end("completed");
    expect(exporter.getFinishedSpans()).toHaveLength(n);
  });
});
