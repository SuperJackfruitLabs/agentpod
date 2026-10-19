import { expect, test } from "bun:test";
import {
  AcpSessionRow,
  SalaamAcpFeatures,
  AcpClientMsg,
  SalaamPromptReceipt,
  AcpServerMsg,
} from "./acp-session";
test("logical prompt UUID is additive to old clients; malformed transport ids cannot become durable instructions", () => {
  expect(AcpClientMsg.parse({ t: "prompt", text: "hello" })).toEqual({
    t: "prompt",
    text: "hello",
  });
  const requestId = crypto.randomUUID();
  expect(
    AcpClientMsg.parse({ t: "prompt", text: "hello", requestId }),
  ).toMatchObject({ requestId });
  expect(
    AcpClientMsg.safeParse({
      t: "prompt",
      text: "hello",
      requestId: "jsonrpc-7",
    }).success,
  ).toBe(false);
  const receipt = {
    sessionId: "acps_fixture",
    requestId,
    attemptId: crypto.randomUUID(),
    state: "accepted",
  };
  expect(SalaamPromptReceipt.parse(receipt)).toEqual(receipt);
  expect(AcpServerMsg.parse({ t: "prompt-receipt", receipt })).toMatchObject({
    receipt,
  });
  expect(
    SalaamPromptReceipt.safeParse({ ...receipt, state: "success-assumed" })
      .success,
  ).toBe(false);
});

test("receipt recovery requires the supported feature versions", () => {
  expect(
    SalaamAcpFeatures.safeParse({ promptReceipts: 1, updateIds: 1 }).success,
  ).toBe(true);
  expect(
    SalaamAcpFeatures.safeParse({ promptReceipts: 0, updateIds: 1 }).success,
  ).toBe(false);
  expect(SalaamAcpFeatures.safeParse({}).success).toBe(false);
});

test("the Hub advertises prompt receipts additively, while older session rows remain valid", () => {
  const row = {
    id: "s1",
    stationId: "st1",
    userId: "u1",
    mode: "ask",
    status: "idle",
    endedReason: null,
    createdAt: "now",
    lastEventAt: "now",
    execution: {
      state: "active",
      sessionId: crypto.randomUUID(),
      stopConfirmed: false,
    },
  };
  expect(AcpSessionRow.parse(row).execution?.promptReceipts).toBeUndefined();
  expect(
    AcpSessionRow.parse({
      ...row,
      execution: { ...row.execution, promptReceipts: 1 },
    }).execution?.promptReceipts,
  ).toBe(1);
});
