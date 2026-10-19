import { expect, test } from "bun:test";
import corpus from "./fixtures/salaam-acp-v1.json";
import {
  SalaamAcpFailure,
  SalaamCancellationReceipt,
  SalaamExecutionFeatures,
} from "./salaam-acp";

for (const [cases, schema] of [
  [corpus.failures, SalaamAcpFailure],
  [corpus.cancellations, SalaamCancellationReceipt],
  [corpus.features, SalaamExecutionFeatures],
] as const)
  for (const sample of cases)
    test(`shared ACP corpus: ${sample.name}`, () => {
      expect(schema.safeParse(sample.value).success).toBe(sample.accept);
    });

test("Salaam typed failures retain correlation and reject unsupported structure", () => {
  const failure = {
    version: 1,
    kind: "auth",
    code: "provider_auth",
    message: "Fixture provider rejected authentication",
    sessionId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    retryable: false,
    provider: "fixture",
    model: "model",
  };
  expect(SalaamAcpFailure.parse(failure)).toEqual(failure);
  for (const patch of [
    { version: 2 },
    { kind: "assumed-success" },
    { code: "arbitrary metadata" },
    { token: "must-not-cross" },
  ])
    expect(SalaamAcpFailure.safeParse({ ...failure, ...patch }).success).toBe(
      false,
    );
});
test("cancellation confirmation requires observed absence of active and unresolved work", () => {
  const receipt = {
    version: 1,
    sessionId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    targetRequestId: crypto.randomUUID(),
    attemptIds: [crypto.randomUUID()],
    state: "confirmed",
    activeAttemptIds: [],
    unresolvedOperationIds: [],
    unconfirmedResources: [],
  };
  expect(SalaamCancellationReceipt.parse(receipt)).toEqual(receipt);
  expect(
    SalaamCancellationReceipt.safeParse({
      ...receipt,
      activeAttemptIds: receipt.attemptIds,
    }).success,
  ).toBe(false);
  expect(
    SalaamCancellationReceipt.safeParse({
      ...receipt,
      unresolvedOperationIds: ["operation_fixture"],
    }).success,
  ).toBe(false);
  expect(
    SalaamCancellationReceipt.safeParse({
      ...receipt,
      unconfirmedResources: ["worker_fixture"],
    }).success,
  ).toBe(false);
  expect(
    SalaamCancellationReceipt.safeParse({
      ...receipt,
      state: "requested",
      activeAttemptIds: receipt.attemptIds,
    }).success,
  ).toBe(true);
  expect(
    SalaamCancellationReceipt.safeParse({
      ...receipt,
      state: "unknown",
      unresolvedOperationIds: ["operation_fixture"],
    }).success,
  ).toBe(true);
});
test("execution feature negotiation is separate from the strict legacy receipt namespace", () => {
  expect(
    SalaamExecutionFeatures.safeParse({
      failures: 1,
      cancellationReceipts: 1,
      toolSemantics: 1,
    }).success,
  ).toBe(true);
  expect(
    SalaamExecutionFeatures.safeParse({
      failures: 1,
      cancellationReceipts: 0,
      toolSemantics: 1,
    }).success,
  ).toBe(false);
  expect(
    SalaamExecutionFeatures.safeParse({
      failures: 1,
      cancellationReceipts: 1,
      toolSemantics: 1,
      coding: true,
    }).success,
  ).toBe(false);
});
