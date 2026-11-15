import { expect, test } from "bun:test";
import { BENCH_COORDINATOR_VERB, parseBenchCoordinatorCurrentRequest, parseBenchCoordinatorCurrentResponse } from "./bench-coordinator";
import { VERB_PARAMS, VERB_RESULTS } from "./protocol";
import corpus from "./fixtures/bench-coordinator-current-v1.json";
import coordinator from "./fixtures/bench-coordinator-v1.json";
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

for (const vector of corpus.requests) test(`current request: ${vector.name}`, () => {
  if (vector.accept) expect<unknown>(parseBenchCoordinatorCurrentRequest(encode(vector.value))).toEqual(vector.value);
  else expect(() => parseBenchCoordinatorCurrentRequest(encode(vector.value))).toThrow("Coordinator current request refused");
});
for (const vector of corpus.responses) test(`current response: ${vector.name}`, async () => {
  const result = parseBenchCoordinatorCurrentResponse(encode(vector.value), new TextEncoder().encode(vector.request_raw), vector.now_ms);
  if (vector.accept) expect<unknown>(await result).toEqual(vector.value);
  else await expect(result).rejects.toThrow("Coordinator current response refused");
});
for (const vector of corpus.lexical) test(`current lexical: ${vector.name}`, () => {
  expect(() => parseBenchCoordinatorCurrentRequest(new TextEncoder().encode(vector.raw))).toThrow("Coordinator current request refused");
});
test("dedicated broker verb uses the exact strict coordinator schema", () => {
  expect(VERB_PARAMS[BENCH_COORDINATOR_VERB].safeParse(coordinator.requests[0]?.value).success).toBe(true);
  expect(VERB_PARAMS[BENCH_COORDINATOR_VERB].safeParse({ key: "station", argv: ["untrusted"] }).success).toBe(false);
  expect(VERB_RESULTS[BENCH_COORDINATOR_VERB].safeParse({ ok: true, result: {} }).success).toBe(false);
});
