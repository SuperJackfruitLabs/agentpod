import { describe, expect, it } from "bun:test";
import { GatewayClientMessage, TurnErrorMsg, TurnErrorReport } from "./gateway";
import { NodeCapabilityList } from "./posture";

/**
 * A harness plugin's report of a failed turn, and the frame the node wraps it
 * in. See docs/superpowers/specs/2026-09-25-harness-error-standard-design.md §2.
 */
describe("TurnErrorReport — what a plugin writes to its node", () => {
  // What krishna's turn at 2026-09-25 05:47 would have reported: OpenClaw's
  // agent_end had success false and the Kimi sentence; model_call_ended saw
  // the fallback chain.
  const openclaw = {
    harnessSessionKey: "agent:krishna:main",
    error: {
      message: "⚠️ You've reached your weekly (7-day) usage limit.",
      kind: "quota",
      provider: "kimi-coding",
      model: "k2p6",
      attempts: [
        { provider: "kimi-coding", model: "k2p6", kind: "quota", message: "403 weekly usage limit" },
        { provider: "opencode-go", model: "qwen3.7-plus", kind: "bad_request", message: "400 MissingSessionID" },
      ],
    },
  };

  it("parses OpenClaw's, keyed by its own session key", () => {
    expect(TurnErrorReport.parse(openclaw)).toEqual(openclaw);
  });

  it("parses Pi's, keyed by the hub session the node gave it", () => {
    const pi = { acpSessionId: "acps_123", error: { message: "401 invalid x-api-key" } };
    expect(TurnErrorReport.parse(pi)).toEqual(pi);
  });

  it("does not let a plugin name the harness or the source: the hub knows both", () => {
    const parsed = TurnErrorReport.parse({
      ...openclaw,
      error: { ...openclaw.error, harness: "claude-code", source: "acp-rejection" },
    });
    expect("harness" in parsed.error).toBe(false);
    expect("source" in parsed.error).toBe(false);
  });

  it("needs something to match a session by", () => {
    expect(TurnErrorReport.safeParse({ error: { message: "x" } }).success).toBe(false);
  });

  it("needs the words", () => {
    expect(TurnErrorReport.safeParse({ harnessSessionKey: "k", error: {} }).success).toBe(false);
  });

  it("refuses an unbounded message: a plugin is not a log shipper", () => {
    const huge = { harnessSessionKey: "k", error: { message: "x".repeat(8_193) } };
    expect(TurnErrorReport.safeParse(huge).success).toBe(false);
  });
});

describe("the turn.error frame", () => {
  it("is a message a node may send", () => {
    const frame = { type: "turn.error", report: { harnessSessionKey: "agent:krishna:main", error: { message: "boom" } } };
    expect(TurnErrorMsg.parse(frame)).toEqual(frame);
    expect(GatewayClientMessage.safeParse(frame).success).toBe(true);
  });

  it("is advertised as a node capability, so the hub and apn know the node takes reports", () => {
    expect(NodeCapabilityList.parse(["turn.errors"])).toEqual(["turn.errors"]);
  });
});
