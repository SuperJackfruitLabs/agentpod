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

import {
  SalaamWorkExpiry,
  SalaamWorkExpiryReceipt,
} from "../../../../packages/contract/src/salaam-work-settlement";
import expiry from "../../../../packages/contract/src/fixtures/salaam-work-expiry-v1.json";
test("expired approval settlement is distinct from never-dispatched settlement", () => {
  expect(JSON.stringify(SalaamWorkExpiry.parse(expiry.request))).toBe(
    JSON.stringify(expiry.request),
  );
  expect(JSON.stringify(SalaamWorkExpiryReceipt.parse(expiry.receipt))).toBe(
    JSON.stringify(expiry.receipt),
  );
  expect(SalaamWorkSettlement.safeParse(expiry.request).success).toBe(false);
  expect(SalaamWorkSettlementReceipt.safeParse(expiry.receipt).success).toBe(
    false,
  );
  expect(
    SalaamWorkExpiryReceipt.safeParse({
      ...expiry.receipt,
      effects: "never_dispatched",
    }).success,
  ).toBe(false);
});
