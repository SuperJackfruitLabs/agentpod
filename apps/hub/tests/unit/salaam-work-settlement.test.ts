import { expect, test } from "bun:test";
import {
  SalaamWorkSettlement,
  SalaamWorkSettlementReceipt,
} from "../../../../packages/contract/src/salaam-work-settlement";
import corpus from "../../../../packages/contract/src/fixtures/salaam-work-settlement-v1.json";
test("shared terminal settlement contract is closed and never reports success", () => {
  expect(JSON.stringify(SalaamWorkSettlement.parse(corpus.request))).toBe(
    JSON.stringify(corpus.request),
  );
  expect(
    JSON.stringify(SalaamWorkSettlementReceipt.parse(corpus.receipt)),
  ).toBe(JSON.stringify(corpus.receipt));
  for (const value of [
    { ...corpus.request, grant: true },
    { ...corpus.request, producer_terminal_digest: "unknown" },
  ])
    expect(SalaamWorkSettlement.safeParse(value).success).toBe(false);
  for (const value of [
    { ...corpus.receipt, state: "succeeded" },
    { ...corpus.receipt, effects: "verified" },
    { ...corpus.receipt, version: 2 },
    { ...corpus.receipt, grant: true },
  ])
    expect(SalaamWorkSettlementReceipt.safeParse(value).success).toBe(false);
});
