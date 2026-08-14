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
  isAutoAnswered,
  permissionQuestion,
  selectedOptionId,
  toBoardOptions,
} from "./permission";

/** What a harness offers over ACP: an id for the machine, a name for the human. */
const OFFERED = [
  { optionId: "allow_once", name: "Yes, run it", kind: "allow_once" },
  { optionId: "allow_always", name: "Yes, and don't ask again", kind: "allow_always" },
  { optionId: "reject_once", name: "No", kind: "reject_once" },
];

describe("ACP options → kaambaan options", () => {
  test("the machine identity is the name; the human label is the title", () => {
    // kaambaan echoes the chosen option's `name` back in `answer.option`, and
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

describe("kaambaan's answer → the ACP option", () => {
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
