import { describe, expect, test } from "bun:test";
import {
  ExecutionEvidenceV1,
  ExecutionExportReceiptV1,
} from "./execution-evidence";
import { z } from "zod";
import schema from "./fixtures/execution-evidence-v1.schema.json";
import corpus from "./fixtures/execution-evidence-v1.json";
describe("explicit execution evidence shared corpus", () => {
  for (const row of corpus.success)
    test(row.name, () =>
      expect(ExecutionEvidenceV1.safeParse(row.value).success).toBe(true),
    );
  for (const row of corpus.rejection)
    test(row.name, () =>
      expect(ExecutionEvidenceV1.safeParse(row.value).success).toBe(false),
    );
});

test("generated JSON Schema is pinned to canonical Zod contract", () =>
  expect(JSON.stringify(z.toJSONSchema(ExecutionEvidenceV1))).toBe(
    JSON.stringify(schema),
  ));

import exportCorpus from "./fixtures/execution-export-v1.json";
for (const row of exportCorpus.success)
  test("export: " + row.name, () =>
    expect(ExecutionExportReceiptV1.safeParse(row.value).success).toBe(true),
  );
for (const row of exportCorpus.rejection)
  test("export: " + row.name, () =>
    expect(ExecutionExportReceiptV1.safeParse(row.value).success).toBe(false),
  );
import exportSchema from "./fixtures/execution-export-v1.schema.json";
test("export JSON Schema parity", () =>
  expect(JSON.stringify(z.toJSONSchema(ExecutionExportReceiptV1))).toBe(
    JSON.stringify(exportSchema),
  ));
import { ExecutionArtifactBundleV1 } from "./execution-evidence";
import artifactSchema from "./fixtures/execution-artifacts-v1.schema.json";
import artifactCorpus from "./fixtures/execution-artifacts-v1.json";
test("source artifact bundle JSON Schema parity and closed corpus", () => {
  expect(JSON.stringify(z.toJSONSchema(ExecutionArtifactBundleV1))).toBe(
    JSON.stringify(artifactSchema),
  );
  for (const row of artifactCorpus.success)
    expect(ExecutionArtifactBundleV1.safeParse(row.value).success).toBe(true);
  for (const row of artifactCorpus.rejection)
    expect(ExecutionArtifactBundleV1.safeParse(row.value).success).toBe(false);
  expect(
    ExecutionArtifactBundleV1.safeParse({
      ...artifactCorpus.success[0]!.value,
      workspace: "/private",
    }).success,
  ).toBe(false);
});
