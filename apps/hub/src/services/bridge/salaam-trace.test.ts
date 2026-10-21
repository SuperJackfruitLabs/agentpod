import { expect, test, spyOn } from "bun:test";
import { context, trace, ROOT_CONTEXT, TraceFlags } from "@opentelemetry/api";
import { ensureContextManager } from "../../telemetry/otel";
import { forwardSalaamWorkTrace, traceDeliveryEvidence } from "./salaam-trace";
import * as broker from "../broker";
import corpus from "../../../../../packages/contract/src/fixtures/execution-evidence-v1.json";
const binding = {
  ...corpus.success[0]!.value.binding,
  workspace: "/workspace",
} as Parameters<typeof forwardSalaamWorkTrace>[0];
test("missing trace is no-op; trace transport failure is unavailable, never an execution error", async () => {
  // The Hub suite shares one process. Use its context lifecycle so this file
  // cannot unregister the manager used by later logger/trace tests.
  ensureContextManager();
  let calls = 0;
  const mock = spyOn(broker, "request").mockImplementation(
    async (_node, verb, body: any) => {
      calls++;
      expect(verb).toBe("salaam.work-trace");
      expect(body.binding).toEqual(binding);
      expect(body.traceparent).toBe(
        "00-" + "1".repeat(32) + "-" + "2".repeat(16) + "-01",
      );
      return { ok: false, error: "offline" };
    },
  );
  try {
    expect(await forwardSalaamWorkTrace(binding)).toBe("unreported");
    expect(calls).toBe(0);
    const active = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      traceFlags: TraceFlags.SAMPLED,
    });
    expect(
      await context.with(active, () => forwardSalaamWorkTrace(binding)),
    ).toBe("unavailable");
    expect(calls).toBe(1);
  } finally {
    mock.mockRestore();
  }
});

test("recorded root correlation never claims collector delivery", () => {
  expect(traceDeliveryEvidence("recorded")).toEqual({
    trace_context_status: "recorded",
    telemetry_status: "delivery_unconfirmed",
  });
  expect(traceDeliveryEvidence("unavailable")).toEqual({
    trace_context_status: "unavailable",
    telemetry_status: "unavailable",
  });
  expect(traceDeliveryEvidence(null)).toEqual({
    trace_context_status: "unreported",
    telemetry_status: "unreported",
  });
  // Unsupported ledger values cannot create an affirmative delivery claim.
  expect(traceDeliveryEvidence("delivered")).toEqual({
    trace_context_status: "unavailable",
    telemetry_status: "unavailable",
  });
});
