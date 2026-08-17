import { describe, expect, test } from "bun:test";
import {
  matchPermissionAnswer,
  permissionPrompt,
  unmatchedAnswerText,
  type PermissionOption,
} from "./permissions";

const OPTIONS: PermissionOption[] = [
  { optionId: "allow_once", name: "Allow once" },
  { optionId: "allow_always", name: "Allow always" },
  { optionId: "reject", name: "Reject" },
];

describe("the question, as it arrives in the room", () => {
  test("numbers the options and says how to answer", () => {
    const text = permissionPrompt("Write src/main.ts", OPTIONS);

    expect(text).toContain("Permission needed: Write src/main.ts");
    expect(text).toContain("1. Allow once");
    expect(text).toContain("3. Reject");
    expect(text).toMatch(/reply with the number/i);
  });

  test("says plainly when there is nothing to choose between", () => {
    // An empty numbered list waiting for an answer that cannot exist is worse
    // than admitting the room cannot serve this one.
    const text = permissionPrompt("Something", []);

    expect(text).toMatch(/no options/i);
    expect(text).not.toMatch(/reply with the number/i);
  });
});

describe("matching a reply to an option", () => {
  test("takes the number as printed, one-based", () => {
    expect(matchPermissionAnswer("1", OPTIONS)).toBe("allow_once");
    expect(matchPermissionAnswer("3", OPTIONS)).toBe("reject");
    expect(matchPermissionAnswer(" 2 ", OPTIONS)).toBe("allow_always");
  });

  test("takes the option's name, however it was capitalised", () => {
    expect(matchPermissionAnswer("Allow once", OPTIONS)).toBe("allow_once");
    expect(matchPermissionAnswer("reject", OPTIONS)).toBe("reject");
  });

  test("takes the option id, which is what a scripted answer would send", () => {
    expect(matchPermissionAnswer("allow_always", OPTIONS)).toBe("allow_always");
  });

  test("refuses a number outside the list rather than wrapping or clamping", () => {
    expect(matchPermissionAnswer("0", OPTIONS)).toBeNull();
    expect(matchPermissionAnswer("4", OPTIONS)).toBeNull();
    expect(matchPermissionAnswer("99", OPTIONS)).toBeNull();
  });

  test("refuses anything that merely sounds like agreement", () => {
    // The one failure this must never have is approving a tool call the
    // operator did not mean to approve. Against options named "Allow once"
    // and "Allow always", a bare "yes" does not say which — and "sure",
    // "ok", "go ahead" say even less.
    for (const reply of ["yes", "y", "sure", "ok", "go ahead", "do it", "allow"]) {
      expect(matchPermissionAnswer(reply, OPTIONS)).toBeNull();
    }
  });

  test("refuses an empty or whitespace reply", () => {
    expect(matchPermissionAnswer("", OPTIONS)).toBeNull();
    expect(matchPermissionAnswer("   ", OPTIONS)).toBeNull();
  });

  test("matches nothing when there is nothing to match", () => {
    expect(matchPermissionAnswer("1", [])).toBeNull();
  });
});

describe("when a reply matched nothing", () => {
  test("shows the options again and says nothing was approved", () => {
    // The operator has to know two things at once: that their message did not
    // count, and what would.
    const text = unmatchedAnswerText(OPTIONS);

    expect(text).toMatch(/nothing has been approved/i);
    expect(text).toContain("1. Allow once");
  });
});
