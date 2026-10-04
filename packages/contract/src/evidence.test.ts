import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EvidenceAttemptResponse, EvidencePrincipalResponse, EvidenceRunResponse } from "./evidence";

const dir = join(import.meta.dir, "../../../fixtures/evidence");
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));

/** Deep-merge a patch into a copy, arrays merged by index. */
function patched(base: unknown, patch: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(patch)) return base.map((v, i) => (i < patch.length ? patched(v, patch[i]) : v));
  if (base && patch && typeof base === "object" && typeof patch === "object") {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = k in out ? patched(out[k], v) : v;
    return out;
  }
  return patch;
}

describe("hub_evidence_run.json", () => {
  const corpus = read("hub_evidence_run.json");
  for (const ex of corpus.examples) {
    test(`accepts: ${ex.name}`, () => {
      expect(EvidenceRunResponse.safeParse(ex.response).error).toBeUndefined();
    });
  }
  for (const r of corpus.reject) {
    test(`rejects: ${r.reason}`, () => {
      expect(EvidenceRunResponse.safeParse(patched(corpus.examples[0].response, r.patch)).success).toBe(false);
    });
  }
});

describe("hub_evidence_attempt.json", () => {
  for (const ex of read("hub_evidence_attempt.json").examples) {
    test(`accepts: ${ex.name}`, () => {
      expect(EvidenceAttemptResponse.safeParse(ex.response).error).toBeUndefined();
    });
  }
});

describe("hub_evidence_principal.json", () => {
  const corpus = read("hub_evidence_principal.json");
  for (const ex of corpus.examples) {
    test(`accepts: ${ex.name}`, () => {
      expect(EvidencePrincipalResponse.safeParse(ex.response).error).toBeUndefined();
    });
  }
  for (const r of corpus.reject) {
    test(`rejects: ${r.reason}`, () => {
      expect(EvidencePrincipalResponse.safeParse(r.response).success).toBe(false);
    });
  }
});

test("an attempt without agent_principal_id is refused: absent is not null", () => {
  const ex = read("hub_evidence_run.json").examples[0].response;
  const { agent_principal_id: _drop, ...attempt } = ex.attempts[0];
  expect(EvidenceRunResponse.safeParse({ ...ex, attempts: [attempt] }).success).toBe(false);
});
