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

// Readable approvals: an optional structured detail of what is being approved.
const detail = {
    version: 1,
    summary: "Create runs/run_x/answer.md in the workspace",
    reason: "Write the quoted sentence the card asks for.",
    files: [{ path: "runs/run_x/answer.md", change: "create", bytes: 249, preview: "# RFC 9110: 502 Bad Gateway" }],
    digest: "f".repeat(64),
  };
test("a decision may carry a readable approval detail, bound into its digest", () => {
  const withDetail = SalaamWorkDecision.parse({ ...corpus.decision, detail });
  expect(withDetail.detail).toEqual(detail);
  expect(createHash("sha256").update(canonicalSalaamWork(withDetail)).digest("hex")).not.toBe(corpus.decision_digest);
});
for (const [name, bad] of Object.entries({
  version: { ...detail, version: 2 },
  digest: { ...detail, digest: "x" },
  change: { ...detail, files: [{ ...detail.files[0], change: "rename" }] },
  extra: { ...detail, grant: true },
  empty: { ...detail, summary: "" },
}))
  test(`decision detail rejects ${name}`, () =>
    expect(SalaamWorkDecision.safeParse({ ...corpus.decision, detail: bad }).success).toBe(false));
