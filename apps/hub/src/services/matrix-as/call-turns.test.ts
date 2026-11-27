import { beforeEach, describe, expect, test } from "bun:test";
import { SPOKEN_PROMPT_PREFIX } from "./call-config";
import {
  callTurnOutcome,
  callTurnSession,
  callTurnsCancelled,
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

  test("a turn id that is not a lower-case UUIDv4 (treaty's pattern) is not", () => {
    // The id keys the hub's turn map and names a path at superdial-agent: anything else a member
    // types into the marker makes the message an ordinary one.
    for (const turnId of [
      "t-1",
      "8D3B0A52-1C51-4C2B-9B55-2F1E0B4A6F10", // upper case
      "8d3b0a52-1c51-1c2b-9b55-2f1e0b4a6f10", // version 1
      "8d3b0a52-1c51-4c2b-7b55-2f1e0b4a6f10", // not the RFC variant
      "8d3b0a521c514c2b9b552f1e0b4a6f10", // no hyphens
      ` ${TURN}`,
      `${TURN}\n`,
    ]) {
      expect(spokenTurn(marked({ turn_id: turnId, agent_user_id: AGENT }), AGENT)).toBeNull();
    }
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
  const ROOM = "!a:id.agentpod.dev";
  const OTHER_ROOM = "!b:id.agentpod.dev";

  test("a noted turn is found, and forgotten once answered", () => {
    noteCallTurns(ROOM, "acps_1", [TURN]);
    expect(callTurnSession(ROOM, TURN)).toBe("acps_1");
    forgetCallTurns(ROOM, [TURN]);
    expect(callTurnSession(ROOM, TURN)).toBeUndefined();
  });

  test("its outcome: cancelled over error over ok", () => {
    noteCallTurns(ROOM, "acps_1", ["a", "b"]);
    expect(callTurnOutcome(ROOM, "a", false)).toBe("ok");
    expect(callTurnOutcome(ROOM, "a", true)).toBe("error");
    markCallTurnCancelled(ROOM, "a");
    expect(callTurnOutcome(ROOM, "a", true)).toBe("cancelled");
    // A cancel for a turn the hub never ran marks nothing.
    markCallTurnCancelled(ROOM, "unknown");
    expect(callTurnOutcome(ROOM, "unknown", false)).toBe("ok");
  });

  test("a turn id is its room's: the same id in another room is another turn", () => {
    // A member of a second room who reuses a live turn id there must not take the first room's
    // turn over, cancel it, or forget it.
    noteCallTurns(ROOM, "acps_1", [TURN]);
    noteCallTurns(OTHER_ROOM, "acps_2", [TURN]);
    expect(callTurnSession(ROOM, TURN)).toBe("acps_1");
    expect(callTurnSession(OTHER_ROOM, TURN)).toBe("acps_2");

    markCallTurnCancelled(OTHER_ROOM, TURN);
    expect(callTurnsCancelled(OTHER_ROOM, [TURN])).toBe(true);
    expect(callTurnsCancelled(ROOM, [TURN])).toBe(false);
    expect(callTurnOutcome(ROOM, TURN, false)).toBe("ok");

    forgetCallTurns(OTHER_ROOM, [TURN]);
    expect(callTurnSession(OTHER_ROOM, TURN)).toBeUndefined();
    expect(callTurnSession(ROOM, TURN)).toBe("acps_1");
  });

  test("a turn noted in a room no other room can see is unknown everywhere else", () => {
    noteCallTurns(ROOM, "acps_1", [TURN]);
    expect(callTurnSession(OTHER_ROOM, TURN)).toBeUndefined();
    markCallTurnCancelled(OTHER_ROOM, TURN);
    expect(callTurnsCancelled(ROOM, [TURN])).toBe(false);
  });
});
