/**
 * The execution schemas are treaty's since v0.0.19 (`schemas/agentpod/execution-{export,evidence,
 * artifacts}.v1.json`, their cases in `fixtures/agentpod-evidence/examples.json`). The zod here is
 * still where AgentPod's code reads them, so it is pinned to treaty's copies: its generated JSON
 * Schema equals treaty's, less the `$id`, `title` and `description` treaty added; it accepts every
 * valid case and refuses every invalid one; and the corpora the hub's tests import
 * (`fixtures/execution-*-v1.json`) are those cases, row for row.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  ExecutionArtifactBundleV1,
  ExecutionEvidenceV1,
  ExecutionExportReceiptV1,
} from "./execution-evidence";
import evidenceCorpus from "./fixtures/execution-evidence-v1.json";
import exportCorpus from "./fixtures/execution-export-v1.json";
import artifactCorpus from "./fixtures/execution-artifacts-v1.json";

const treaty = (path: string): unknown =>
  JSON.parse(
    readFileSync(
      join(
        Bun.resolveSync("@superjackfruitlabs/treaty-contracts/data/manifest.json", import.meta.dir),
        "..",
        path,
      ),
      "utf8",
    ),
  );

const Cases = z.object({
  valid: z.record(z.string(), z.unknown()),
  invalid: z.array(z.object({ why: z.string(), body: z.unknown() })),
});
const Rows = z.array(z.object({ name: z.string(), value: z.unknown() }));
const Corpus = z.object({ success: Rows, rejection: Rows });
const JsonObject = z.record(z.string(), z.unknown());

const examples = z
  .object({ schemas: z.record(z.string(), Cases) })
  .parse(treaty("fixtures/agentpod-evidence/examples.json"));

/** Treaty's schema, less the keys it added for its own catalogue. */
function treatySchema(name: string): Record<string, unknown> {
  const { $id: _id, title: _title, description: _description, ...rest } = JsonObject.parse(
    treaty(`schemas/agentpod/${name}.json`),
  );
  return rest;
}

const SHAPES: Array<[string, z.ZodType, z.infer<typeof Corpus>]> = [
  ["execution-evidence.v1", ExecutionEvidenceV1, Corpus.parse(evidenceCorpus)],
  ["execution-export.v1", ExecutionExportReceiptV1, Corpus.parse(exportCorpus)],
  ["execution-artifacts.v1", ExecutionArtifactBundleV1, Corpus.parse(artifactCorpus)],
];

for (const [name, schema, corpus] of SHAPES) {
  describe(name, () => {
    const cases = examples.schemas[name];
    if (!cases) throw new Error(`treaty keeps no cases for ${name}`);

    test("the zod's JSON Schema is treaty's", () => {
      const generated: unknown = z.toJSONSchema(schema);
      expect(generated).toEqual(treatySchema(name));
    });

    for (const [why, value] of Object.entries(cases.valid))
      test(`accepts ${why}`, () => expect(schema.safeParse(value).success).toBe(true));
    for (const { why, body } of cases.invalid)
      test(`refuses ${why}`, () => expect(schema.safeParse(body).success).toBe(false));

    test("the corpus the hub's tests import is treaty's cases", () => {
      expect(Object.fromEntries(corpus.success.map((r) => [r.name, r.value]))).toEqual(cases.valid);
      expect(corpus.rejection.map((r) => ({ why: r.name, body: r.value }))).toEqual(cases.invalid);
    });
  });
}

test("an artifact bundle that names a workspace path is refused", () => {
  const first = Corpus.parse(artifactCorpus).success[0];
  if (!first) throw new Error("the artifact corpus has no valid row");
  expect(
    ExecutionArtifactBundleV1.safeParse({ ...JsonObject.parse(first.value), workspace: "/private" }).success,
  ).toBe(false);
});
