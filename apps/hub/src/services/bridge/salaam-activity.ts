import { z } from "zod";
import type { AcpEvent } from "@agentpod/contract";
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

/** The ACP plan update Salaam's work-status carries (salaam `planUpdate`). */
const SalaamPlan = z
  .object({
    sessionUpdate: z.literal("plan"),
    entries: z
      .array(
        z
          .object({
            content: z.string().max(512),
            priority: z.enum(["high", "medium", "low"]),
            status: z.enum(["pending", "in_progress", "completed"]),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();

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
  /** `onEvent` sees each synthetic ACP event, for the standard agent spans. */
  constructor(
    after = 0,
    private readonly onEvent: (event: AcpEvent) => void = () => {},
  ) {
    this.last = after;
  }
  private lastPlan: string | undefined;
  /**
   * The task plan, posted when it changes. A durable thought, not the coalescer's ephemeral
   * plan thought: superpipeline leaves ephemeral activities out of a card's activity list, and
   * the plan has to be there before work starts.
   */
  plan(update: unknown): BoardActivity[] {
    const parsed = SalaamPlan.safeParse(update);
    if (!parsed.success || !parsed.data.entries.length) return [];
    const body =
      "Plan:\n" +
      parsed.data.entries
        .map((e, n) => `${n + 1}. ${e.content} (${e.status.replace("_", " ")})`)
        .join("\n");
    if (body === this.lastPlan) return [];
    this.lastPlan = body;
    return [{ type: "thought", body }];
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
      const event: AcpEvent = {
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
      };
      try {
        this.onEvent(event);
      } catch {
        /* telemetry never changes the work */
      }
      out.push(...coalescer.push(event));
    }
    return [...out, ...coalescer.flush()];
  }
}
