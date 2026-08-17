/**
 * When a turn's live text is worth pushing to the reader's devices.
 *
 * The rule is boundary-first, not timer-first, and these tests are mostly about
 * that: a timer chops sentences in half, and half a sentence on screen reads
 * worse than a pause. See `live.ts` for why this channel exists at all rather
 * than streaming into the room by edits.
 */

import { describe, expect, test } from "bun:test";
import {
  deltaContent,
  endsAtBoundary,
  MAX_DELTA_WAIT_MS,
  MIN_DELTA_CHARS,
  shouldSendDelta,
} from "./live";

describe("deciding when to send", () => {
  test("nothing new is never worth a round trip", () => {
    expect(shouldSendDelta("", 0)).toBe(false);
    expect(shouldSendDelta("", MAX_DELTA_WAIT_MS * 10)).toBe(false);
  });

  test("a finished sentence with enough behind it goes at once", () => {
    expect(shouldSendDelta("I looked at the node and it is online.", 200)).toBe(true);
  });

  test("a sentence still in progress waits, however long it is", () => {
    // The failure this prevents: "I looked at the node and it is" on screen,
    // then a jump. Waiting reads better than tearing.
    const midSentence = "I looked at the node and it is currently".padEnd(400, " x");
    expect(shouldSendDelta(midSentence, 200)).toBe(false);
  });

  test("a boundary with almost nothing behind it waits too", () => {
    // "Hi." on its own is a round trip to move three characters.
    expect("Hi.".length).toBeLessThan(MIN_DELTA_CHARS);
    expect(shouldSendDelta("Hi.", 200)).toBe(false);
  });

  test("the backstop fires for text that never reaches a boundary", () => {
    // An agent emitting one long unpunctuated block still has to show
    // movement. This is the only case where a delta may cut mid-sentence.
    const noBoundary = "and then it kept going without ever stopping to punctuate";
    expect(shouldSendDelta(noBoundary, MAX_DELTA_WAIT_MS)).toBe(true);
  });
});

describe("what counts as a boundary", () => {
  test("sentence enders do, with or without a closing quote", () => {
    for (const text of ["Done.", "Really?", "Stop!", "wait…", 'He said "no."', "See these:"]) {
      expect(endsAtBoundary(text)).toBe(true);
    }
  });

  test("a newline does, because a paragraph break is a pause a reader takes", () => {
    expect(endsAtBoundary("First point\n")).toBe(true);
    expect(endsAtBoundary("First point\n\n")).toBe(true);
  });

  test("a comma does not — stopping there reads as a stall, not a beat", () => {
    expect(endsAtBoundary("I checked the node,")).toBe(false);
  });

  test("mid-word does not", () => {
    expect(endsAtBoundary("I checked the nod")).toBe(false);
  });
});

describe("the wire body", () => {
  test("carries everything so far, not the increment", () => {
    // To-device delivery is at-least-once and unordered. An increment would let
    // one dropped or reordered delta corrupt the text with nothing able to
    // notice; cumulative text plus a seq is self-correcting.
    const content = deltaContent({
      roomId: "!r:x.org",
      sessionId: "s1",
      seq: 3,
      text: "One. Two. Three.",
      done: false,
    });

    expect(content).toEqual({
      room_id: "!r:x.org",
      session_id: "s1",
      seq: 3,
      text: "One. Two. Three.",
      done: false,
    });
  });

  test("marks the last delta of a turn, so a reader can drop the live view", () => {
    const content = deltaContent({
      roomId: "!r:x.org",
      sessionId: "s1",
      seq: 9,
      text: "All of it.",
      done: true,
    });

    expect(content.done).toBe(true);
  });
});
