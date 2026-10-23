import { z } from "zod";
import { ActivityCoalescer, type BoardActivity } from "./coalesce";

/** The tool-step tail Salaam's work-status carries (salaam `AgentPodWork.activity`). */
const SalaamActivityTail = z
  .array(
    z
      .object({
        seq: z.number().int().nonnegative(),
        phase: z.enum(["started", "finished"]),
        tool_call_id: z.string().max(256),
        title: z.string().max(512),
        kind: z.string().max(64).nullable(),
        input: z.string().max(2048).nullable(),
        failed: z.boolean(),
      })
      .strict(),
  )
  .max(64);

const rawInput = (input: string | null) => {
  if (input === null) return undefined;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
};

/**
 * Turns strict Salaam work's tool steps into card activity. Each step is replayed through the
 * same coalescer a live ACP session feeds, as the ACP tool_call / tool_call_update Salaam's own
 * ACP surface emits, so a Salaam card reads exactly like a streamed one. Observation only: a
 * tail that does not parse posts nothing, and nothing here touches the work.
 */
export class SalaamActivityFeed {
  private last: number;
  constructor(after = 0) {
    this.last = after;
  }
  cursor(): number {
    return this.last;
  }
  next(tail: unknown): BoardActivity[] {
    const parsed = SalaamActivityTail.safeParse(tail);
    if (!parsed.success) return [];
    const coalescer = new ActivityCoalescer();
    const out: BoardActivity[] = [];
    for (const step of [...parsed.data].sort((a, b) => a.seq - b.seq)) {
      if (step.seq <= this.last) continue;
      this.last = step.seq;
      out.push(
        ...coalescer.push({
          sessionId: "salaam",
          seq: step.seq,
          type: "agent-update",
          createdAt: "",
          payload:
            step.phase === "started"
              ? {
                  sessionUpdate: "tool_call",
                  toolCallId: step.tool_call_id,
                  title: step.title,
                  kind: step.kind ?? undefined,
                  status: "in_progress",
                  rawInput: rawInput(step.input),
                }
              : {
                  sessionUpdate: "tool_call_update",
                  toolCallId: step.tool_call_id,
                  title: step.title,
                  status: step.failed ? "failed" : "completed",
                },
        }),
      );
    }
    return [...out, ...coalescer.flush()];
  }
}
