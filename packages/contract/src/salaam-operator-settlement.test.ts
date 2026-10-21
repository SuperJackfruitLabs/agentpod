import { describe, expect, test } from "bun:test";
import { SalaamOperatorSettlementRequest } from "./index";

const request = {
  runId: "run_abcdef",
  requestId: "86424ba3-f48c-4fe3-baf6-83b36634bb5b",
};
const decisionRequestId = "d1c06e7d-f33b-4186-a361-77787e04a440";

describe("Salaam operator settlement request", () => {
  test("preserves the omitted-mode default and existing modes", () => {
    expect(SalaamOperatorSettlementRequest.parse(request).mode).toBe(
      "never-dispatched",
    );
    for (const mode of [
      "never-dispatched",
      "known-effects-failure",
      "unreported-local-success",
    ])
      expect(
        SalaamOperatorSettlementRequest.safeParse({ ...request, mode }).success,
      ).toBe(true);
  });
  test("requires an exact UUID decision only for expired approval", () => {
    expect(
      SalaamOperatorSettlementRequest.parse({
        ...request,
        mode: "expired-approval",
        decisionRequestId,
      }),
    ).toEqual({ ...request, mode: "expired-approval", decisionRequestId });
    for (const decision of [undefined, null, "", "not-a-uuid"])
      expect(
        SalaamOperatorSettlementRequest.safeParse({
          ...request,
          mode: "expired-approval",
          decisionRequestId: decision,
        }).success,
      ).toBe(false);
    for (const mode of [
      undefined,
      "never-dispatched",
      "known-effects-failure",
      "unreported-local-success",
    ])
      expect(
        SalaamOperatorSettlementRequest.safeParse({
          ...request,
          mode,
          decisionRequestId,
        }).success,
      ).toBe(false);
  });
  test("remains closed and rejects invalid identity or mode", () => {
    for (const patch of [
      { approve: true },
      { mode: "retry" },
      { runId: "wrong" },
      { requestId: "wrong" },
      { decision_request_id: decisionRequestId },
    ])
      expect(
        SalaamOperatorSettlementRequest.safeParse({ ...request, ...patch })
          .success,
      ).toBe(false);
  });
});
