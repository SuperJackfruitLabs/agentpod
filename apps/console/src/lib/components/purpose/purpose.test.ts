import { describe, expect, it } from "vitest";
import {
  nodePurposeConsequence,
  normalisePurpose,
  purposeChanged,
  purposeProblem,
  PURPOSE_MAX,
} from "./purpose";

describe("normalisePurpose", () => {
  it("trims what was typed", () => {
    expect(normalisePurpose("  work ")).toBe("work");
  });

  it("reads an empty box as no purpose at all", () => {
    // Unlabelled is a real state with its own meaning — filed under no space,
    // still in All rooms — so clearing the field has to reach it rather than
    // land on a purpose that is the empty string.
    expect(normalisePurpose("")).toBeNull();
    expect(normalisePurpose("   ")).toBeNull();
  });
});

describe("purposeChanged", () => {
  it("is false when the box says what the agent already says", () => {
    expect(purposeChanged("work", "work")).toBe(false);
    expect(purposeChanged("  work  ", "work")).toBe(false);
    expect(purposeChanged("", null)).toBe(false);
  });

  it("is true for a real edit, including clearing one", () => {
    expect(purposeChanged("personal", "work")).toBe(true);
    expect(purposeChanged("", "work")).toBe(true);
    expect(purposeChanged("work", null)).toBe(true);
  });
});

describe("purposeProblem", () => {
  it("passes an ordinary label", () => {
    expect(purposeProblem("ad hoc R&D")).toBeNull();
  });

  it("refuses one longer than the hub will take", () => {
    expect(purposeProblem("x".repeat(PURPOSE_MAX + 1))).toMatch(/64/);
  });
});

describe("nodePurposeConsequence", () => {
  it("says how many agents a node's purpose will also label", () => {
    // Setting a node's purpose writes to rows the operator did not name. Saying
    // so before it happens beats reporting it afterwards.
    expect(nodePurposeConsequence(3)).toContain("3 agents");
    expect(nodePurposeConsequence(1)).toContain("1 agent");
  });

  it("says plainly when it will label nothing", () => {
    expect(nodePurposeConsequence(0)).toContain("Only future agents");
  });
});
