import { beforeEach, describe, expect, test } from "bun:test";
import { SPOKEN_PROMPT_PREFIX } from "./call-config";
import {
  callTurnOutcome,
  callTurnSession,
  forgetCallTurns,
  markCallTurnCancelled,
  noteCallTurns,
  resetCallTurnsForTest,
  spokenPrompt,
  spokenTurn,
} from "./call-turns";

/**
 * C3, read by the hub: a message carrying `dev.superdial.spoken` for THIS room's agent is a
 * spoken turn. One naming another agent, or without a turn id, is an ordinary message — the
 * marker is not a way to send a reply somewhere it was not asked for.
 */

const AGENT = "@agent_ada:id.agentpod.dev";
const TURN = "8d3b0a52-1c51-4c2b-9b55-2f1e0b4a6f10";

const marked = (spoken: unknown) => ({ msgtype: "m.text", body: "what time is it", "dev.superdial.spoken": spoken });

beforeEach(() => resetCallTurnsForTest());

describe("the spoken-turn marker", () => {
  test("a marker for this room's agent is a spoken turn", () => {
    expect(spokenTurn(marked({ turn_id: TURN, agent_user_id: AGENT, audio_ms: 2310 }), AGENT)).toEqual({ turnId: TURN });
  });

  test("a marker for another agent, without a turn id, or malformed, is not", () => {
    expect(spokenTurn(marked({ turn_id: TURN, agent_user_id: "@agent_bob:id.agentpod.dev", audio_ms: 1 }), AGENT)).toBeNull();
    expect(spokenTurn(marked({ agent_user_id: AGENT, audio_ms: 1 }), AGENT)).toBeNull();
    expect(spokenTurn(marked({ turn_id: "", agent_user_id: AGENT }), AGENT)).toBeNull();
    expect(spokenTurn(marked({ turn_id: 7, agent_user_id: AGENT }), AGENT)).toBeNull();
    expect(spokenTurn(marked("yes"), AGENT)).toBeNull();
    expect(spokenTurn({ msgtype: "m.text", body: "typed" }, AGENT)).toBeNull();
    expect(spokenTurn(undefined, AGENT)).toBeNull();
  });

  test("only a text message is a spoken turn", () => {
    expect(spokenTurn({ ...marked({ turn_id: TURN, agent_user_id: AGENT }), msgtype: "m.notice" }, AGENT)).toBeNull();
  });

  test("the prompt is the contract's prefix and the words", () => {
    expect(spokenPrompt("  what time is it ")).toBe(
      "[Spoken in a call, transcribed. Answer briefly, in plain sentences without markdown.] what time is it",
    );
    expect(SPOKEN_PROMPT_PREFIX).toBe(
      "[Spoken in a call, transcribed. Answer briefly, in plain sentences without markdown.]",
    );
  });
});

describe("which ACP turn a spoken turn became", () => {
  test("a noted turn is found, and forgotten once answered", () => {
    noteCallTurns("acps_1", [TURN]);
    expect(callTurnSession(TURN)).toBe("acps_1");
    forgetCallTurns([TURN]);
    expect(callTurnSession(TURN)).toBeUndefined();
  });

  test("its outcome: cancelled over error over ok", () => {
    noteCallTurns("acps_1", ["a", "b"]);
    expect(callTurnOutcome("a", false)).toBe("ok");
    expect(callTurnOutcome("a", true)).toBe("error");
    markCallTurnCancelled("a");
    expect(callTurnOutcome("a", true)).toBe("cancelled");
    // A cancel for a turn the hub never ran marks nothing.
    markCallTurnCancelled("unknown");
    expect(callTurnOutcome("unknown", false)).toBe("ok");
  });
});
