/**
 * The two translations a human decision passes through.
 *
 * This file exists because both directions are silent when they are wrong. An
 * option that maps to the wrong identity does not throw; it approves something
 * a human declined, or declines something they approved, and the only evidence
 * is a tool call that ran (or did not) in a workspace nobody is watching.
 */

import { describe, expect, test } from "bun:test";

import {
  boardPermissionSubject,
  isAutoAnswered,
  permissionQuestion,
  selectedOptionId,
  toBoardOptions,
  toMeaningfulBoardOptions,
  withoutEnvelope,
} from "./permission";
import { harnessPermissionSubject } from "../acp";

/** What a harness offers over ACP: an id for the machine, a name for the human. */
const OFFERED = [
  { optionId: "allow_once", name: "Yes, run it", kind: "allow_once" },
  { optionId: "allow_always", name: "Yes, and don't ask again", kind: "allow_always" },
  { optionId: "reject_once", name: "No", kind: "reject_once" },
];

describe("ACP options → superpipeline options", () => {
  test("the machine identity is the name; the human label is the title", () => {
    // superpipeline echoes the chosen option's `name` back in `answer.option`, and
    // ACP answers by `optionId`. So `name` MUST be the optionId — putting the
    // human label there produces an answer that maps to nothing.
    expect(toBoardOptions(OFFERED)).toEqual([
      { name: "allow_once", title: "Yes, run it" },
      { name: "allow_always", title: "Yes, and don't ask again" },
      { name: "reject_once", title: "No" },
    ]);
  });

  test("an option with no label is still answerable", () => {
    expect(toBoardOptions([{ optionId: "allow_once" }])).toEqual([
      { name: "allow_once", title: "allow_once" },
    ]);
  });

  test("an option with no id is dropped — it could never be answered", () => {
    expect(toBoardOptions([{ name: "Yes" }, { optionId: "reject_once", name: "No" }])).toEqual([
      { name: "reject_once", title: "No" },
    ]);
  });

  test("a missing or malformed option list is an empty list, not a throw", () => {
    expect(toBoardOptions(undefined)).toEqual([]);
    expect(toBoardOptions(null)).toEqual([]);
    expect(toBoardOptions("allow_once")).toEqual([]);
    expect(toBoardOptions([1, 2, 3])).toEqual([]);
  });
});

describe("superpipeline's answer → the ACP option", () => {
  test("an approval round-trips to the option the human chose", () => {
    const chosen = toBoardOptions(OFFERED)[0]!;
    expect(selectedOptionId(OFFERED, { option: chosen.name })).toBe("allow_once");
  });

  test("a DENIAL round-trips too — the answer is delivered, not interpreted", () => {
    // The dangerous mutation this test exists to kill: a mapping that returns an
    // allow option regardless of what came back approves, in a workspace, a
    // command a human explicitly refused.
    const chosen = toBoardOptions(OFFERED)[2]!;
    expect(selectedOptionId(OFFERED, { option: chosen.name })).toBe("reject_once");
    expect(selectedOptionId(OFFERED, { option: chosen.name })).not.toBe("allow_once");
    expect(selectedOptionId(OFFERED, { option: chosen.name })).not.toBe("allow_always");
  });

  test("every offered option round-trips to itself and to nothing else", () => {
    for (const board of toBoardOptions(OFFERED)) {
      expect(selectedOptionId(OFFERED, { option: board.name })).toBe(board.name);
    }
  });

  test("the human's LABEL is not an answer", () => {
    // If the board ever hands back a title instead of a name, that is not a
    // decision this bridge can act on. Guessing which option it meant is how a
    // relabelled "No" becomes an approval.
    expect(selectedOptionId(OFFERED, { option: "Yes, run it" })).toBeNull();
  });

  test("an option that was never offered is not an answer", () => {
    expect(selectedOptionId(OFFERED, { option: "rm_rf" })).toBeNull();
  });

  test("free text alone is not an answer", () => {
    expect(selectedOptionId(OFFERED, { option: null, text: "go ahead" })).toBeNull();
    expect(selectedOptionId(OFFERED, { text: "sure" })).toBeNull();
    expect(selectedOptionId(OFFERED, { option: "  " })).toBeNull();
  });

  test("no answer at all is not an answer", () => {
    expect(selectedOptionId(OFFERED, null)).toBeNull();
    expect(selectedOptionId(OFFERED, undefined)).toBeNull();
  });
});

describe("the question a human reads", () => {
  test("it names the tool call the agent is asking about", () => {
    expect(permissionQuestion({ toolCall: { title: "Run `bun test`" } })).toContain("Run `bun test`");
  });

  test("a request with no title still asks something answerable", () => {
    expect(permissionQuestion({})).toMatch(/permission/i);
  });
});

describe("a request the hub already answered", () => {
  test("full-auto and accept-edits mark their own approvals", () => {
    // `handlePermissionRequest` persists a permission-request event even when it
    // auto-allows. Treating one as a question puts a card in `input-required`
    // for a decision that was made microseconds earlier and is already gone.
    expect(isAutoAnswered({ auto: true, toolCall: { title: "Write a.ts" } })).toBe(true);
    expect(isAutoAnswered({ toolCall: { title: "Write a.ts" } })).toBe(false);
    expect(isAutoAnswered({ auto: false })).toBe(false);
    expect(isAutoAnswered(null)).toBe(false);
  });
});

describe("a board-dispatched permission carries its meanings and subject (charter 2026-11-07 §7)", () => {
  const PAYLOAD = { toolCall: { title: "Run it", kind: "execute", rawInput: { command: "make" } }, options: OFFERED };

  test("meanings and scopes come from ACP's kinds; an option with no kind is a neutral choice", () => {
    expect(toMeaningfulBoardOptions([...OFFERED, { optionId: "later", name: "Later" }])).toEqual([
      { name: "allow_once", title: "Yes, run it", meaning: "approve", scope: "once" },
      { name: "allow_always", title: "Yes, and don't ask again", meaning: "approve", scope: "always" },
      { name: "reject_once", title: "No", meaning: "reject", scope: "once" },
      { name: "later", title: "Later", meaning: "choose" },
    ]);
  });

  test("the subject is the station room's: same id, digest and expiry", () => {
    const at = "2026-11-07T10:00:00.000Z";
    const board = boardPermissionSubject("acps_x", 3, PAYLOAD, at);
    const room = harnessPermissionSubject("acps_x", 3, PAYLOAD, new Date(at)).subject;
    expect(board).toEqual(room);
    expect(board.expires_at).toBe("2026-11-07T10:30:00.000Z");
  });

  test("a preview too large for a board is cut, and then it is incomplete", () => {
    const big = { ...PAYLOAD, toolCall: { ...PAYLOAD.toolCall, rawInput: { command: "x".repeat(20_000) } } };
    const subject = boardPermissionSubject("acps_x", 3, big, "2026-11-07T10:00:00.000Z");
    expect(subject.preview_complete).toBe(false);
    for (const b of subject.preview) expect(JSON.stringify(b).length).toBeLessThan(16_000);
    const many = { ...PAYLOAD, toolCall: { ...PAYLOAD.toolCall, locations: Array.from({ length: 80 }, (_, i) => ({ path: `f${i}` })) } };
    const listed = boardPermissionSubject("acps_x", 3, many, "2026-11-07T10:00:00.000Z");
    expect(listed.preview.length).toBeLessThanOrEqual(20);
    expect(listed.preview_complete).toBe(false);
  });

  test("without the envelope, the question is exactly what was posted before", () => {
    const activity = {
      type: "elicitation",
      body: "q",
      parameter: { requestSeq: 4, options: toMeaningfulBoardOptions(OFFERED), subject: boardPermissionSubject("acps_x", 4, PAYLOAD, null) },
    };
    expect(withoutEnvelope(activity)).toEqual({ type: "elicitation", body: "q", parameter: { requestSeq: 4, options: toBoardOptions(OFFERED) } });
    expect(withoutEnvelope({ type: "elicitation", parameter: { requestSeq: 4, options: toBoardOptions(OFFERED) } })).toBeNull();
    expect(withoutEnvelope({ type: "thought", body: "x" })).toBeNull();
  });
});
