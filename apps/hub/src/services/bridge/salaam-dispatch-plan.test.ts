import { describe, expect, test } from "bun:test";
import { SalaamPlanRefused, isSalaamPlanRefused, planFrom } from "./salaam-dispatch-plan";
import type { RunContext } from "./superpipeline";

/** The refusal `planFrom` throws for this spec, or null when it throws something else or nothing. */
function refusal(spec: unknown): SalaamPlanRefused | null {
  try {
    planFrom(context(spec));
  } catch (err) {
    return err instanceof SalaamPlanRefused ? err : null;
  }
  return null;
}

function context(spec: unknown): RunContext {
  return {
    run: {
      runId: "run_x",
      cardId: "card_x",
      stageKey: "draft",
      leaseEpoch: 1,
      status: "running",
      outcome: null,
      startedAt: "2026-11-10T21:09:44.000Z",
      endedAt: null,
    },
    card: { id: "card_x", title: "Proof", spec },
    stage: null,
    handoff: null,
    references: [],
  };
}

/**
 * A card a strict Salaam station cannot run as written must say why, in words a person can act on.
 *
 * Found on staging, 2026-11-10: a card without `spec.salaam` was claimed, refused by a bare zod
 * error ("Invalid input: expected object, received undefined"), handed back, and claimed again —
 * 230 times in two hours. The refusal is about the card, so no retry can fix it. The start path
 * tells it apart by `isSalaamPlanRefused`, so the message and the type both have to hold.
 */
describe("a card a Salaam station cannot run", () => {
  test("a card with no spec says it needs a spec.salaam plan", () => {
    expect(() => planFrom(context(undefined))).toThrow(SalaamPlanRefused);
    expect(() => planFrom(context(undefined))).toThrow(/spec\.salaam plan/);
  });

  test("a spec without salaam names the missing field, not a zod path", () => {
    const message = refusal({ instructions: "Write one sentence." })?.message ?? "";
    expect(message).toContain("spec.salaam");
    expect(message).toContain("{ version: 1, plan }");
    expect(message).not.toContain("expected object, received undefined");
  });

  test("an invalid plan names where it is invalid", () => {
    expect(refusal({ salaam: { version: 1, plan: { objective: "x" } } })?.message).toMatch(/spec\.salaam\.plan\.\w+/);
  });

  test("an ordinary failure is not mistaken for one", () => {
    // A station that is offline or a board that cannot be read must keep the release path.
    expect(isSalaamPlanRefused(new Error("Node is offline."))).toBe(false);
    expect(isSalaamPlanRefused(undefined)).toBe(false);
    expect(isSalaamPlanRefused({ name: "SalaamPlanRefused", message: "shaped" })).toBe(true);
  });
});
