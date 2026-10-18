import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { VERB_PARAMS, VERB_RESULTS } from "./protocol";

// The same file the node agent's Go gateway test decodes: both sides read one set of frames.
const fx = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/forge-api/frames.json"), "utf8")) as {
  params: Record<string, unknown>;
  results: Record<string, unknown>;
  resultsWithBypass: Record<string, unknown>;
};

const verbs = ["deliver", "policy", "verify", "revoke", "status"].map((v) => `forge.api.${v}` as const);

test("every forge.api params fixture parses with the strict hub schema", () => {
  for (const v of verbs) {
    const r = VERB_PARAMS[v].safeParse(fx.params[v]);
    expect(r.success, `${v}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
  }
});

test("every forge.api result fixture parses with the hub result schema", () => {
  for (const v of verbs) {
    const r = VERB_RESULTS[v].safeParse(fx.results[v]);
    expect(r.success, `${v}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
  }
});

test("a params frame with an extra key is rejected, never stripped", () => {
  for (const v of verbs) {
    expect(VERB_PARAMS[v].safeParse({ ...(fx.params[v] as object), token: "x" }).success).toBe(false);
  }
});

test("the verify result fixture carries the bypass section the node sends", () => {
  const r = VERB_RESULTS["forge.api.verify"].safeParse(fx.resultsWithBypass["forge.api.verify"]);
  expect(r.success).toBe(true);
  if (!r.success) return;
  expect(r.data.bypass?.clients.map((c) => c.outcome)).toEqual(["honoured", "refused-ca", "untested"]);
  expect(r.data.bypass?.brokered).toBe(false);
  expect(r.data.bypass?.measured).toBe("partial");
  expect(r.data.bypass?.wiringBlocked).toContain("HTTPS_PROXY");
  // an older node omits it, and a newer node adding a field or an outcome word is still readable
  expect(VERB_RESULTS["forge.api.verify"].safeParse({ ok: true, isolation: "separate-user" }).success).toBe(true);
  expect(
    VERB_RESULTS["forge.api.verify"].safeParse({
      ok: true,
      isolation: "separate-user",
      bypass: { clients: [{ client: "x", outcome: "new-word", extra: 1 }], brokered: true, extra: 1 },
    }).success,
  ).toBe(true);
});

test("measured is complete|partial only, and brokered is a required boolean", () => {
  const base = { ok: true, isolation: "separate-user" };
  const ok = (bypass: unknown) => VERB_RESULTS["forge.api.verify"].safeParse({ ...base, bypass }).success;
  expect(ok({ clients: [], brokered: false, measured: "complete" })).toBe(true);
  expect(ok({ clients: [], brokered: false })).toBe(true);
  expect(ok({ clients: [], brokered: false, measured: "everything" })).toBe(false);
  expect(ok({ clients: [] })).toBe(false);
});
