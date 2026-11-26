import { expect, test } from "bun:test";
import { BenchCoordinatorAttachRequest, BenchCoordinatorFinishRequest, BenchCoordinatorRemoteCredential, BenchCoordinatorRequest,
  benchCoordinatorBindingDigest, parseBenchCoordinatorRequest, parseBenchCoordinatorResponse } from "./bench-coordinator";
import corpus from "./fixtures/bench-coordinator-v1.json";
const reverse = (v: unknown): unknown => Array.isArray(v) ? v.map(reverse) : v !== null && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).toReversed().map(([k, x]) => [k, reverse(x)])) : v;

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
for (const c of corpus.requests) test(`coordinator request: ${c.name}`, () => {
  expect(BenchCoordinatorRequest.safeParse(c.value).success).toBe(c.accept);
  if (c.accept) expect<unknown>(parseBenchCoordinatorRequest(encode(c.value))).toEqual(c.value);
  else expect(() => parseBenchCoordinatorRequest(encode(c.value))).toThrow("Coordinator request refused");
});
for (const c of corpus.responses) test(`coordinator response: ${c.name}`, async () => {
  const result = parseBenchCoordinatorResponse(encode(c.value), c.request);
  if (c.accept) expect<unknown>(await result).toEqual(c.value);
  else await expect(result).rejects.toThrow("Coordinator response refused");
});
for (const c of corpus.lexical) test(`coordinator lexical: ${c.name}`, () => {
  expect(() => parseBenchCoordinatorRequest(new TextEncoder().encode(c.raw))).toThrow("Coordinator request refused");
});
test("binding field order and digest are stable across input property order", async () => {
  const b: unknown = JSON.parse(corpus.binding_canonical);
  expect(await benchCoordinatorBindingDigest(b)).toBe(corpus.binding_sha256);
  expect(await benchCoordinatorBindingDigest(reverse(b))).toBe(corpus.binding_sha256);
});
test("whole serialized UTF-8 request limit refuses multibyte prompt", () => {
  const v = BenchCoordinatorRequest.parse(corpus.requests.at(1)?.value);
  if (v.operation !== "prepare") throw new Error("prepare fixture missing");
  v.task.prompt = "界".repeat(23000);
  expect(BenchCoordinatorRequest.safeParse(v).success).toBe(false);
  expect(() => parseBenchCoordinatorRequest(encode(v))).toThrow("Coordinator request refused");
});
test("raw limits, bad UTF-8 and deeply nested inputs refuse with closed errors", () => {
  for (const raw of [new Uint8Array(65537), new Uint8Array([0xff]), new TextEncoder().encode("[".repeat(66) + "0" + "]".repeat(66))])
    expect(() => parseBenchCoordinatorRequest(raw)).toThrow("Coordinator request refused");
});
test("whole response raw-byte cap applies before parsing even with valid trailing whitespace", async () => {
  const c = corpus.responses.at(0);
  if (!c) throw new Error("response fixture missing");
  const raw = new TextEncoder().encode(JSON.stringify(c.value) + " ".repeat(256 * 1024));
  await expect(parseBenchCoordinatorResponse(raw, c.request)).rejects.toThrow("Coordinator response refused");
});
test("failure mapping never echoes injected wire text", async () => {
  const c = corpus.responses.at(0);
  if (!c) throw new Error("response fixture missing");
  try { await parseBenchCoordinatorResponse(encode({ ...c.value, lease_token: "fixture-secret" }), c.request); }
  catch (error) { expect(String(error)).toBe("Error: Coordinator response refused"); return; }
  throw new Error("unsafe data accepted");
});
test("handoff own keys remain data and neither mutate input nor prototypes", async () => {
  const c = corpus.responses.find((v) => v.name === "own-prototype-handoff-keys");
  if (!c) throw new Error("handoff fixture missing");
  const original = JSON.stringify(c.value);
  const r = await parseBenchCoordinatorResponse(encode(c.value), c.request);
  if (r.state !== "completed") throw new Error("completion fixture missing");
  expect(Object.hasOwn(r.completion.task.handoff, "__proto__")).toBe(true);
  expect(r.completion.task.handoff["__proto__"]).toBe("untrusted text");
  expect(Object.getPrototypeOf(r.completion.task.handoff)).toBe(Object.prototype);
  expect(JSON.stringify(c.value)).toBe(original);
});
const named = (n: string) => corpus.requests.find((c) => c.name === n);
test("attach and finish: the shared corpus the Go wire reads holds their valid and invalid bodies", () => {
  // Guards a vacuous pass: the loops above run these through Zod exactly as wire_test.go runs them through Go.
  for (const n of ["attach", "finish", "attach-public-key-at-limit", "attach-public-key-over-limit", "attach-lease_token",
    "finish-handoff-at-canonical-limit", "finish-handoff-over-canonical-limit", "finish-handoff-non-ascii-over-canonical-limit"])
    expect(named(n)).toBeDefined();
  expect(BenchCoordinatorAttachRequest.safeParse(named("attach")?.value).success).toBe(true);
  expect(BenchCoordinatorFinishRequest.safeParse(named("finish")?.value).success).toBe(true);
  expect(BenchCoordinatorAttachRequest.safeParse(named("finish")?.value).success).toBe(false);
  const attached = corpus.responses.find((c) => c.name === "attached")?.value as { credential?: unknown } | undefined;
  expect(BenchCoordinatorRemoteCredential.safeParse(attached?.credential).success).toBe(true);
  for (const n of ["attached", "finish-completed", "finish-refused-dirty", "attached-with-lease-token", "finish-completed-other-binding"])
    expect(corpus.responses.find((c) => c.name === n)).toBeDefined();
});
