import { expect, test } from "bun:test";
import { prepareSalaamWork, workDigest } from "../../src/services/salaam-work";
import corpus from "../../../../packages/contract/src/fixtures/salaam-work-v1.json";
import {
  SalaamWorkPlan,
  SalaamWorkPayload,
} from "../../../../packages/contract/src/salaam-work-payload";
import { SalaamWorkAdmission } from "../../../../packages/contract/src/salaam-work";
const admission = SalaamWorkAdmission.parse(corpus.replays[0]!.saved);
const input = {
  instructions: "Inspect source",
  references: ["library:card"],
  incoming_handoff: null,
};
const plan = {
  objective: "Inspect",
  constraints: [],
  steps: [
    {
      key: "inspect",
      title: "Inspect",
      instruction: "Read source",
      depends_on: [],
      checks: ["verify"],
    },
  ],
  acceptance: [{ key: "verify", command: "test -f src/a.ts", cwd: "." }],
  deliverables: ["src/a.ts"],
  limits: {
    requests: 2,
    runtime_ms: 10000,
    concurrency: 1,
    token_units: 10000,
    input_token_bound: 1024,
    output_token_bound: 1024,
    verification_runs: 2,
  },
};
const prepare = (i: unknown = input, p: unknown = plan) =>
  prepareSalaamWork(
    admission.request_id,
    admission.binding,
    admission.work,
    i,
    p,
  );
test("producer derives digests from explicit input and expanded plan", () => {
  const result = prepare();
  expect(result.admission.work.input_digest).toBe(workDigest(input));
  expect(result.admission.work.plan_digest).toBe(workDigest(plan));
  expect(result.admission.work.input_digest).not.toBe(
    admission.work.input_digest,
  );
  expect(
    prepare({ ...input, incoming_handoff: "Changed" }).admission.work
      .input_digest,
  ).not.toBe(result.admission.work.input_digest);
  expect(
    prepare(input, { ...plan, limits: { ...plan.limits, requests: 3 } })
      .admission.work.plan_digest,
  ).not.toBe(result.admission.work.plan_digest);
});
test("canonical order is stable; reference order is significant", () => {
  expect(workDigest({ b: 1, a: ["x", "y"] })).toBe(
    workDigest({ a: ["x", "y"], b: 1 }),
  );
  expect(workDigest(["x", "y"])).not.toBe(workDigest(["y", "x"]));
});
for (const [name, changed] of Object.entries({
  omittedLimits: { ...plan, limits: undefined },
  unknownGrant: { ...plan, mayExecute: true },
  forwardDependency: {
    ...plan,
    steps: [{ ...plan.steps[0], depends_on: ["later"] }],
  },
  unknownCheck: { ...plan, steps: [{ ...plan.steps[0], checks: ["missing"] }] },
  traversal: { ...plan, deliverables: ["../private"] },
  duplicate: { ...plan, deliverables: ["a", "a"] },
  uncappedBudget: {
    ...plan,
    limits: { ...plan.limits, output_token_bound: null },
  },
}))
  test(`reject ${name} before control dispatch`, () =>
    expect(() => prepare(input, changed)).toThrow());
test("input cannot carry model-supplied authority or digests", () => {
  expect(() => prepare({ ...input, binding: admission.binding })).toThrow();
  expect(() => prepare({ ...input, input_digest: "a".repeat(64) })).toThrow();
});
test("expanded parsed plan is stable under repeat parsing", () => {
  const parsed = SalaamWorkPlan.parse(plan);
  expect(workDigest(SalaamWorkPlan.parse(parsed))).toBe(workDigest(parsed));
});

import payloadCorpus from "../../../../packages/contract/src/fixtures/salaam-work-payload-v1.json";
for (const sample of payloadCorpus.cases)
  test(`shared producer bytes: ${sample.name}`, () => {
    const p = sample.payload;
    expect(
      prepareSalaamWork(
        p.admission.request_id,
        SalaamWorkAdmission.parse(p.admission).binding,
        p.admission.work,
        p.input,
        p.plan,
      ),
    ).toEqual(SalaamWorkPayload.parse(p));
  });
