import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  SalaamWorkDecision,
  SalaamWorkDecisionAnswer,
} from "./salaam-work-decision";
import { canonicalSalaamWork } from "./salaam-work-payload";
import corpus from "./fixtures/salaam-work-decision-v1.json";
test("shared immutable decision digest covers exact expanded offer", () => {
  const decision = SalaamWorkDecision.parse(corpus.decision);
  expect(
    createHash("sha256").update(canonicalSalaamWork(decision)).digest("hex"),
  ).toBe(corpus.decision_digest);
});
for (const key of Object.keys(corpus.decision))
  test(`decision requires ${key}`, () => {
    const missing = { ...corpus.decision } as Record<string, unknown>;
    delete missing[key];
    expect(SalaamWorkDecision.safeParse(missing).success).toBe(false);
  });
for (const [name, value] of Object.entries({
  unknown: { ...corpus.decision, grant: true },
  permanent: {
    ...corpus.decision,
    options: [
      { id: "approve-always", title: "Always" },
      { id: "deny", title: "Deny" },
    ],
  },
  revision: { ...corpus.decision, plan_revision: 0 },
  digest: { ...corpus.decision, operation_digest: "b".repeat(63) },
  deadline: { ...corpus.decision, expires_at: Infinity },
}))
  test(`decision rejects ${name}`, () =>
    expect(SalaamWorkDecision.safeParse(value).success).toBe(false));
test("answer cannot select a permanent or unoffered approval", () => {
  const answer = {
    version: 1,
    request_id: crypto.randomUUID(),
    decision: corpus.decision,
    decision_digest: corpus.decision_digest,
    elicitation_id: "elc_abcdef",
    option_id: "approve",
    answered_by: "prn_human",
    answered_at: new Date().toISOString(),
  };
  expect(SalaamWorkDecisionAnswer.safeParse(answer).success).toBe(true);
  expect(
    SalaamWorkDecisionAnswer.safeParse({
      ...answer,
      option_id: "approve-always",
    }).success,
  ).toBe(false);
});

import { SuperpipelineStrictDecision } from "./salaam-work-decision";
import producerCorpus from "./fixtures/superpipeline-strict-decision-v1.json";
for (const sample of producerCorpus)
  test(`producer strict decision parity: ${sample.name}`, () =>
    expect(SuperpipelineStrictDecision.safeParse(sample.value).success).toBe(
      sample.valid,
    ));
