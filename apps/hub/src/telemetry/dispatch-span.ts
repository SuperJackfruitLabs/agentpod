/**
 * The root span of one claimed run (superwitness spec §4.1, C1 `dispatch`).
 *
 * A new trace per run: the root is started on ROOT_CONTEXT whatever is active. It begins
 * when the claim was made and ends when the dispatch returns, with the outcome as
 * `dispatch.status`. `reason` is never recorded, because it can carry harness text.
 */
import { context, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import type { DispatchResult } from "../services/bridge/dispatch";
import { AgentSpanRecorder } from "./agent-spans";
import { instruments, tracer } from "./otel";

export interface DispatchSpanInput {
  runId: string;
  boardId: string;
  cardId: string;
  source: string;
  stationId: string;
  startTime: Date;
}

type Status = DispatchResult["status"] | "threw";

const COMPLETED: ReadonlySet<Status> = new Set(["reported", "self-reported", "unreported", "replayed"]);
const ERRORED: ReadonlySet<Status> = new Set(["failed", "foreign-run", "threw"]);

export const attemptStateFor = (status: Status): "completed" | "failed" => (COMPLETED.has(status) ? "completed" : "failed");

export async function inDispatchSpan(
  input: DispatchSpanInput,
  work: (spans: AgentSpanRecorder) => Promise<DispatchResult>,
): Promise<DispatchResult> {
  const span = tracer().startSpan(
    "dispatch",
    {
      startTime: input.startTime,
      attributes: {
        "run.id": input.runId,
        "board.id": input.boardId,
        "card.id": input.cardId,
        "external.source": input.source,
        "station.id": input.stationId,
      },
    },
    ROOT_CONTEXT,
  );
  const ctx = trace.setSpan(ROOT_CONTEXT, span);
  const spans = new AgentSpanRecorder({
    tracer: tracer(),
    parent: ctx,
    stationId: input.stationId,
    runId: input.runId,
    onOpen: (f) => span.setAttributes({ "attempt.id": f.attemptId, "fingerprint.digest": f.fingerprintDigest }),
  });
  let status: Status = "threw";
  try {
    const result = await context.with(ctx, () => work(spans));
    status = result.status;
    return result;
  } finally {
    // Products never block on telemetry: nothing here may replace the result or the original error.
    try {
      spans.end(attemptStateFor(status));
    } catch {
      // a telemetry failure must not change the dispatch's outcome
    }
    try {
      span.setAttribute("dispatch.status", status);
      if (ERRORED.has(status)) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    } catch {
      // as above
    }
    try {
      instruments().dispatches.add(1, { "dispatch.status": status });
    } catch {
      // as above
    }
  }
}
