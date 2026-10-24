import { expect, test } from "bun:test";
import { nextSalaamDecision } from "./salaam-decision-order";

const d = (request_id: string, expires_at: number) => ({ request_id, expires_at });

test("only the oldest pending decision is offered, so a board holds one question per run", () => {
  expect(nextSalaamDecision([d("b", 2000), d("a", 1000), d("c", 3000)])).toEqual(d("a", 1000));
  // Same expiry: the request id decides, so every poll picks the same one.
  expect(nextSalaamDecision([d("z", 1000), d("m", 1000)])).toEqual(d("m", 1000));
  expect(nextSalaamDecision([])).toBeUndefined();
});
