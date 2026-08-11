/**
 * RQ1: ACP transcript event → kaambaan activity envelope.
 *
 * This module IS the research artifact. Its job is as much to record what it
 * cannot map as to map what it can — see `unmapped()` and `losses()`.
 *
 * The top-level mapping (6 AgentPod event types → 5 kaambaan activity types) is
 * trivial. The real work is inside `agent-update`, whose payload is `unknown()`
 * in our own contract and carries the ACP SDK's `sessionUpdate` verbatim. The
 * console's transcript renderer at
 *   apps/console/src/lib/components/stations/chat/transcript.ts
 * already destructures those shapes — it is the reference implementation, and the
 * honest RQ1 comparison is "what the board shows vs what the console shows".
 */

import type { Activity } from "./kaambaan";
import type { AcpEvent } from "./hub";

const UNMAPPED = new Set<string>();
const LOSSES = new Set<string>();

/** Event kinds with no projection at all. */
export const unmapped = (): string[] => [...UNMAPPED].sort();
/** Kinds that project, but lose structure on the way. */
export const losses = (): string[] => [...LOSSES].sort();

export function project(event: AcpEvent): Activity[] {
  const p = event.payload as any;

  switch (event.type) {
    case "user-prompt":
      return [{ type: "thought", body: `prompt: ${p?.text ?? ""}`, ephemeral: true }];

    case "permission-request":
      // ACP offers structured options; kaambaan requires `body` to be a string,
      // so the options can only survive in signalMetadata. Whether they survive
      // the round-trip intact is exactly RQ2.
      return [
        {
          type: "elicitation",
          body: p?.title ?? p?.toolCall?.title ?? "The agent needs permission to continue.",
          signal: "select",
          signalMetadata: { requestSeq: event.seq, options: p?.options ?? [] },
        },
      ];

    case "permission-answer":
      return [
        { type: "thought", body: `permission answered: ${p?.optionId ?? "?"}`, ephemeral: true },
      ];

    case "error":
      return [{ type: "error", body: String(p?.message ?? p ?? "agent error") }];

    case "state":
      // Session lifecycle. kaambaan derives its own task state from activities,
      // so forwarding ours would fight its state machine. Deliberately dropped.
      return [];

    case "agent-update":
      return projectUpdate(p);

    default:
      UNMAPPED.add(event.type);
      return [];
  }
}

function projectUpdate(p: any): Activity[] {
  switch (p?.sessionUpdate) {
    case "agent_message_chunk":
      return [{ type: "thought", body: text(p.content), ephemeral: true }];

    case "agent_thought_chunk":
      // Reasoning collapses into an ephemeral thought — the board has no
      // distinct reasoning affordance, so the console's collapsible block
      // cannot be reconstructed from the activity stream.
      LOSSES.add("agent_thought_chunk → thought (reasoning/message distinction lost)");
      return [{ type: "thought", body: text(p.content), ephemeral: true }];

    case "tool_call":
      return [
        { type: "action", action: p.title ?? p.kind ?? "tool", parameter: p.rawInput ?? p.locations },
      ];

    case "tool_call_update":
      if (p.content && Array.isArray(p.content) && p.content.some((c: any) => c?.type === "diff")) {
        LOSSES.add("tool_call_update diff → action.result (no diff affordance on the board)");
      }
      return [
        { type: "action", action: p.title ?? p.kind ?? "tool", result: p.rawOutput ?? p.content },
      ];

    case "plan":
      LOSSES.add("plan → thought (agent plan has no board representation)");
      return [{ type: "thought", body: JSON.stringify(p.entries ?? p), ephemeral: true }];

    // RQ5. Not all harnesses emit usage; Codex's adapter advertises it, Hermes
    // may not. Recorded per harness in the findings.
    case "usage":
    case "token_usage":
      return [
        {
          type: "thought",
          body: "usage",
          ephemeral: true,
          usage: {
            model: p.model,
            inputTokens: p.inputTokens ?? p.usage?.input_tokens,
            outputTokens: p.outputTokens ?? p.usage?.output_tokens,
            costUsd: p.costUsd ?? p.total_cost_usd,
          },
        },
      ];

    default:
      UNMAPPED.add(`agent-update:${p?.sessionUpdate ?? "?"}`);
      return [];
  }
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  const c = content as any;
  if (c?.type === "text") return String(c.text ?? "");
  if (Array.isArray(c)) return c.map(text).join("");
  return JSON.stringify(content);
}
