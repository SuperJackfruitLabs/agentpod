import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { VERB_PARAMS, VERB_RESULTS } from "./protocol";

// The same file the node agent's Go gateway test decodes: both sides read one set of frames.
const fx = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/forge-api/frames.json"), "utf8")) as {
  params: Record<string, unknown>;
  results: Record<string, unknown>;
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
