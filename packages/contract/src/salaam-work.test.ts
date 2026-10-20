import { expect, test } from "bun:test";
import { SalaamWorkAdmission, checkSalaamWorkAdmission, checkSalaamWorkReplay } from "./salaam-work";
import corpus from "./fixtures/salaam-work-v1.json";
for (const sample of corpus.admissions)
  test(`strict work shape: ${sample.name}`, () => {
    expect(SalaamWorkAdmission.safeParse(sample.value).success).toBe(sample.accept);
  });
for (const sample of corpus.bindings)
  test(`strict work binding: ${sample.name}`, () => {
    const result = checkSalaamWorkAdmission(sample.value, sample.expected);
    expect(result.ok ? "accepted" : result.code).toBe(sample.result);
  });
for (const sample of corpus.replays)
  test(`strict work replay: ${sample.name}`, () => {
    const result = checkSalaamWorkReplay(sample.value, sample.saved);
    expect(result.ok ? "replay" : result.code).toBe(sample.result);
  });
test("comparison does not mutate a saved request", () => {
  const saved = structuredClone(corpus.replays[0]!.saved);
  const before = JSON.stringify(saved);
  checkSalaamWorkReplay(corpus.replays[1]!.value, saved);
  expect(JSON.stringify(saved)).toBe(before);
});

test("field order changes preserve exact saved request meaning", () => {
  const saved = corpus.replays[0]!.saved;
  const reverse = (value: unknown): unknown => value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)]))
    : value;
  expect(checkSalaamWorkReplay(reverse(saved), saved).ok).toBe(true);
});
