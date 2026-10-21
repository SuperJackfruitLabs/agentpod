import { expect, test } from "bun:test";
import {
  evidenceHash,
  manifestBytes,
  exportBytes,
  exportFiles,
  libraryDigest,
  verifyArtifactBundle,
  exportReceipt,
  reserveExecutionExport,
  runExecutionExport,
  type ExportRecord,
  type ExportStore,
} from "./execution-export";
import corpus from "../../../../../packages/contract/src/fixtures/execution-evidence-v1.json";
function harness() {
  const rows = new Map<string, ExportRecord>();
  const store: ExportStore = {
    async reserve(r) {
      if (!rows.has(r.requestId)) rows.set(r.requestId, structuredClone(r));
      return structuredClone(rows.get(r.requestId)!);
    },
    async get(id, t, p) {
      const r = rows.get(id);
      return r && r.tenantId === t && r.principalId === p
        ? structuredClone(r)
        : null;
    },
    async change(id, from, to, patch = {}) {
      const r = rows.get(id)!;
      if (r.status !== from) return false;
      rows.set(id, { ...r, ...patch, status: to });
      return true;
    },
  };
  const scope = {
    requestId: "22222222-2222-4222-8222-222222222222",
    tenantId: "tenant",
    principalId: corpus.success[0]!.value.binding.principal_id,
  };
  const bytes = manifestBytes(corpus.success[0]!.value),
    calls: string[] = [];
  let lost = false;
  const lib = {
    async request(method: string, path: string) {
      calls.push(method + " " + path);
      if (path === "/api/v1/uploads")
        return Response.json({ uploadId: "upl_abc" });
      if (path.endsWith("/commit")) {
        if (lost) {
          lost = false;
          throw Error("network");
        }
        return Response.json({
          itemId: "itm_abcdef",
          version: 1,
          sha256: evidenceHash(bytes),
          bytes: bytes.length,
        });
      }
      if (path.endsWith("/embed"))
        return Response.json({
          version: 1,
          downloadUrl: "https://content.test/frozen",
          entry: "execution-evidence.json",
        });
      return new Response(null, { status: 200 });
    },
  };
  return {
    store,
    scope,
    bytes,
    calls,
    lib,
    rows,
    loseCommit() {
      lost = true;
    },
  };
}
test("persist before effect, restart resumes original upload after lost commit", async () => {
  const h = harness();
  await reserveExecutionExport(h.store, {
    ...h.scope,
    manifest: corpus.success[0]!.value,
  });
  h.loseCommit();
  await expect(
    runExecutionExport(h.store, h.scope, h.lib, async () => h.bytes),
  ).rejects.toThrow("network");
  expect(h.rows.get(h.scope.requestId)?.status).toBe("commit_unconfirmed");
  const result = await runExecutionExport(
    h.store,
    h.scope,
    h.lib,
    async () => h.bytes,
  );
  expect(result.status).toBe("committed");
  expect(h.calls.filter((c) => c === "POST /api/v1/uploads")).toHaveLength(1);
  expect(h.calls.filter((c) => c.endsWith("/commit"))).toHaveLength(2);
  await runExecutionExport(h.store, h.scope, h.lib, async () => h.bytes);
  expect(h.calls.filter((c) => c.endsWith("/commit"))).toHaveLength(2);
});
test("declaration ambiguity never allocates a second upload", async () => {
  const h = harness();
  await reserveExecutionExport(h.store, {
    ...h.scope,
    manifest: corpus.success[0]!.value,
  });
  await expect(
    runExecutionExport(
      h.store,
      h.scope,
      {
        request: async () => {
          throw Error("lost");
        },
      },
      async () => h.bytes,
    ),
  ).rejects.toThrow();
  await expect(
    runExecutionExport(h.store, h.scope, h.lib, async () => h.bytes),
  ).rejects.toThrow("upload_declaration_unconfirmed");
  expect(h.calls).toHaveLength(0);
});
test("scoped historical receipt cannot cross principals; replay cannot replace manifest", async () => {
  const h = harness();
  await reserveExecutionExport(h.store, {
    ...h.scope,
    manifest: corpus.success[0]!.value,
  });
  await expect(
    runExecutionExport(
      h.store,
      { ...h.scope, principalId: "other" },
      h.lib,
      async () => h.bytes,
    ),
  ).rejects.toThrow("export_not_found");
  const changed = structuredClone(corpus.success[0]!.value);
  changed.task.state = "running";
  await expect(
    reserveExecutionExport(h.store, { ...h.scope, manifest: changed }),
  ).rejects.toThrow("export_request_conflict");
  expect(h.calls).toHaveLength(0);
});
test("returned Library bytes are verified independently of commit receipt", async () => {
  const h = harness();
  await reserveExecutionExport(h.store, {
    ...h.scope,
    manifest: corpus.success[0]!.value,
  });
  await expect(
    runExecutionExport(
      h.store,
      h.scope,
      h.lib,
      async () => new Uint8Array([0]),
    ),
  ).rejects.toThrow("library_integrity_failed");
  expect(h.rows.get(h.scope.requestId)?.status).toBe("integrity_failed");
});
test("tampered persisted source stops before network", async () => {
  const h = harness();
  await reserveExecutionExport(h.store, {
    ...h.scope,
    manifest: corpus.success[0]!.value,
  });
  h.rows.get(h.scope.requestId)!.digest = "b".repeat(64);
  await expect(
    runExecutionExport(h.store, h.scope, h.lib, async () => h.bytes),
  ).rejects.toThrow("source_integrity_failed");
  expect(h.calls).toHaveLength(0);
});

test("only committed, byte-verified original exports become citeable receipts", async () => {
  const h = harness();
  const reserved = await reserveExecutionExport(h.store, {
    ...h.scope,
    manifest: corpus.success[0]!.value,
  });
  expect(() => exportReceipt(reserved)).toThrow("artifact_export_unconfirmed");
  const saved = await runExecutionExport(
    h.store,
    h.scope,
    h.lib,
    async () => h.bytes,
  );
  const receipt = exportReceipt(saved);
  expect(receipt.export_id).toBe(h.scope.requestId);
  expect(receipt.manifest_sha256).toBe(evidenceHash(h.bytes));
  expect(receipt.verification).toBe("download-sha256-verified");
  expect(receipt.external_run_id).toBe(corpus.success[0]!.value.binding.run.id);
});

import artifactCorpus from "../../../../../packages/contract/src/fixtures/execution-artifacts-v1.json";

test("source selected artifact bundle freezes verified bytes and rejects corruption, substitution and observed files", async () => {
  const bundle = structuredClone(artifactCorpus.success[0]!.value);
  expect(
    verifyArtifactBundle(bundle, [bundle.artifacts[0]!.id]).artifacts[0]!
      .disposition,
  ).toBe("produced");
  expect(() => verifyArtifactBundle(bundle, [crypto.randomUUID()])).toThrow(
    "artifact_selection_mismatch",
  );
  const corrupt = structuredClone(bundle);
  corrupt.artifacts[0]!.content_base64 =
    Buffer.from("changed").toString("base64");
  expect(() => verifyArtifactBundle(corrupt)).toThrow(
    "source_artifact_integrity_failed",
  );
  const observed = structuredClone(bundle);
  observed.evidence.artifacts[0]!.disposition = "observed";
  expect(() => verifyArtifactBundle(observed)).toThrow(
    "artifact_source_mismatch",
  );
  const h = harness();
  const saved = await reserveExecutionExport(h.store, {
    ...h.scope,
    manifest: bundle.evidence,
    bundle,
  });
  const files = exportFiles(saved),
    bytes = exportBytes(saved);
  let puts = 0;
  const lib = {
    async request(method: string, path: string, init?: { body?: Uint8Array }) {
      if (path === "/api/v1/uploads")
        return Response.json({ uploadId: "upl_bundle" });
      if (method === "PUT") {
        puts++;
        const file = files.find((f) =>
          path.endsWith(encodeURIComponent(f.path)),
        )!;
        expect(init!.body).toEqual(file.bytes);
        return new Response(null, { status: 200 });
      }
      if (path.endsWith("/commit"))
        return Response.json({
          itemId: "itm_bundle",
          version: 1,
          sha256: libraryDigest(files),
          bytes: files.reduce((n, f) => n + f.bytes.length, 0),
        });
      return Response.json({
        version: 1,
        url: "https://content.test/_view?sig=signature",
        entry: "execution-manifest.json",
        files: files.map((f) => ({ path: f.path })),
      });
    },
  };
  const committed = await runExecutionExport(
    h.store,
    h.scope,
    lib,
    async (url) =>
      files.find((f) => url.endsWith(f.path + "?download=1"))!.bytes,
  );
  expect(puts).toBe(2);
  const receipt = exportReceipt(committed);
  expect(receipt.artifact_kind).toBe("execution-artifact-bundle");
  expect(receipt.library.entry).toBe("execution-manifest.json");
  expect(receipt.manifest_sha256).toBe(evidenceHash(bytes));
  expect(receipt.library.sha256).toBe(libraryDigest(files));
  expect(receipt.artifact_files[0]!.file_id).toEqual({
    item_id: "itm_bundle",
    version: 1,
    path: files[1]!.path,
  });
});

test("historical readiness fingerprint content is verified independently before export", async () => {
  const manifest = structuredClone(corpus.success[0]!.value);
  const body = {
    session_id: manifest.task.session_id,
    worker_epoch: 1,
    version: 1 as const,
    harness: "salaam" as const,
    harness_version: "fixture",
    pi_version: "fixture",
    bundle_digest: "a".repeat(64),
    policy_digest: "b".repeat(64),
    provider: "provider",
    model: "model/fixture",
    context_digest: "c".repeat(64),
    context_admission_digest: null,
    verification: "pinned-readiness-handshake" as const,
  };
  const { canonicalSalaamWork } =
    await import("../../../../../packages/contract/src/salaam-work-payload");
  (manifest as unknown as { fingerprints: unknown[] }).fingerprints = [
    {
      ...body,
      digest: evidenceHash(new TextEncoder().encode(canonicalSalaamWork(body))),
    },
  ];
  expect(manifestBytes(manifest).length).toBeGreaterThan(0);
  (
    manifest as unknown as { fingerprints: { model: string }[] }
  ).fingerprints[0]!.model = "forged";
  expect(() => manifestBytes(manifest)).toThrow(
    "readiness_fingerprint_integrity_failed",
  );
});

test("Library raw scan rejection remains an artifact failure and keeps the same upload", async () => {
  const h = harness();
  await reserveExecutionExport(h.store, {
    ...h.scope,
    manifest: corpus.success[0]!.value,
  });
  let declarations = 0,
    commits = 0;
  const lib = {
    async request(method: string, path: string) {
      if (path === "/api/v1/uploads") {
        declarations++;
        return Response.json({ uploadId: "upl_scanned" });
      }
      if (path.endsWith("/commit")) {
        commits++;
        return Response.json({ error: "secret_found" }, { status: 422 });
      }
      return new Response(null, { status: 200 });
    },
  };
  for (let i = 0; i < 2; i++)
    await expect(
      runExecutionExport(h.store, h.scope, lib, async () => h.bytes),
    ).rejects.toThrow("artifact_scan_rejected");
  expect(declarations).toBe(1);
  expect(commits).toBe(2);
  expect(h.rows.get(h.scope.requestId)!.status).toBe("commit_unconfirmed");
});
