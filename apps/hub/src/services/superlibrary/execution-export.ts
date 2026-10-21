import { createHash } from "node:crypto";
import {
  ExecutionEvidenceV1,
  ExecutionExportReceiptV1,
  ExecutionArtifactBundleV1,
  canonicalSalaamWork,
} from "../../../../../packages/contract/src/index";
import type { SuperlibraryCaller } from "./client";
export const evidenceHash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export type ExportStatus =
  | "prepared"
  | "declaring"
  | "uploading"
  | "commit_unconfirmed"
  | "committed"
  | "integrity_failed";
export interface ExportRecord {
  requestId: string;
  tenantId: string;
  principalId: string;
  manifest: unknown;
  digest: string;
  status: ExportStatus;
  uploadId: string | null;
  receipt: unknown;
  bundle?: unknown;
}
export interface ExportStore {
  reserve(record: ExportRecord): Promise<ExportRecord>;
  get(
    requestId: string,
    tenantId: string,
    principalId: string,
  ): Promise<ExportRecord | null>;
  change(
    requestId: string,
    from: ExportStatus,
    to: ExportStatus,
    patch?: Partial<ExportRecord>,
  ): Promise<boolean>;
}
export function verifyExecutionEvidence(value: unknown) {
  const evidence = ExecutionEvidenceV1.parse(value);
  for (const fingerprint of evidence.fingerprints) {
    const { digest, ...body } = fingerprint;
    if (
      evidenceHash(new TextEncoder().encode(canonicalSalaamWork(body))) !==
      digest
    )
      throw Error("readiness_fingerprint_integrity_failed");
  }
  return evidence;
}
export const manifestBytes = (manifest: unknown) =>
  new TextEncoder().encode(
    canonicalSalaamWork(verifyExecutionEvidence(manifest)),
  );
/** Freeze admitted metadata only. Raw producer artifacts/transcripts are never implicitly uploaded. */
export async function reserveExecutionExport(
  store: ExportStore,
  input: {
    requestId: string;
    tenantId: string;
    principalId: string;
    manifest: unknown;
    bundle?: unknown;
  },
) {
  const manifest = verifyExecutionEvidence(input.manifest);
  if (!/^[a-f0-9-]{36}$/.test(input.requestId))
    throw Error("invalid_export_request");
  if (manifest.binding.principal_id !== input.principalId)
    throw Error("export_principal_mismatch");
  const bundle =
    input.bundle === undefined ? undefined : verifyArtifactBundle(input.bundle);
  if (
    bundle &&
    canonicalSalaamWork(bundle.evidence) !== canonicalSalaamWork(manifest)
  )
    throw Error("bundle_evidence_mismatch");
  const digest = evidenceHash(exportBytes({ manifest, bundle }));
  const record = await store.reserve({
    ...input,
    manifest,
    bundle: bundle ?? null,
    digest,
    status: "prepared",
    uploadId: null,
    receipt: null,
  });
  if (
    record.tenantId !== input.tenantId ||
    record.principalId !== input.principalId ||
    record.digest !== digest
  )
    throw Error("export_request_conflict");
  return record;
}
/** The declaration response cannot be atomically committed with our DB. A crash there
 * remains declaring/ambiguous and MUST NOT create another upload. Once saved, all
 * retries reuse exactly uploadId and immutable bytes, including uncertain commits. */
export async function runExecutionExport(
  store: ExportStore,
  scope: { requestId: string; tenantId: string; principalId: string },
  lib: SuperlibraryCaller,
  readContent: (url: string) => Promise<Uint8Array>,
) {
  let record = await store.get(
    scope.requestId,
    scope.tenantId,
    scope.principalId,
  );
  if (!record) throw Error("export_not_found");
  const files = exportFiles(record),
    bytes = files[0]!.bytes,
    manifest = verifyExecutionEvidence(record.manifest),
    entry = files[0]!.path;
  if (evidenceHash(bytes) !== record.digest)
    throw Error("source_integrity_failed");
  if (record.status === "committed") return record;
  if (record.status === "declaring")
    throw Error("upload_declaration_unconfirmed");
  if (record.status === "integrity_failed")
    throw Error("library_integrity_failed");
  if (record.status === "prepared") {
    if (!(await store.change(record.requestId, "prepared", "declaring")))
      throw Error("export_in_progress");
    const response = await lib.request("POST", "/api/v1/uploads", {
      json: {
        title: "Execution evidence",
        scope: `board:${manifest.task.board_id}`,
        entry,
        files: files.map((f) => ({
          path: f.path,
          bytes: f.bytes.length,
          sha256: f.sha256,
        })),
        source: {
          station: manifest.binding.station_id,
          stationName: manifest.binding.station_key,
          path: entry,
          board: manifest.task.board_id,
          card: manifest.task.card_id,
          run: manifest.binding.run.id,
        },
      },
    });
    if (!response.ok) throw Error("upload_declaration_refused");
    const declared = (await response.json()) as { uploadId?: unknown };
    if (
      typeof declared.uploadId !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(declared.uploadId)
    )
      throw Error("invalid_upload_receipt");
    if (
      !(await store.change(record.requestId, "declaring", "uploading", {
        uploadId: declared.uploadId,
      }))
    )
      throw Error("export_state_conflict");
    record = { ...record, status: "uploading", uploadId: declared.uploadId };
  }
  if (!record.uploadId) throw Error("missing_upload_identity");
  const path = `/api/v1/uploads/${encodeURIComponent(record.uploadId)}`;
  if (record.status === "uploading") {
    for (const file of files) {
      const put = await lib.request(
        "PUT",
        path + "/files?path=" + encodeURIComponent(file.path),
        { body: file.bytes },
      );
      if (!put.ok) {
        const reason =
          put.status === 422 ? await put.json().catch(() => null) : null;
        throw Error(
          reason !== null &&
            typeof reason === "object" &&
            "error" in reason &&
            reason.error === "secret_found"
            ? "artifact_scan_rejected"
            : "artifact_upload_failed",
        );
      }
    }
    if (
      !(await store.change(record.requestId, "uploading", "commit_unconfirmed"))
    )
      throw Error("export_state_conflict");
  }
  const commit = await lib.request("POST", path + "/commit");
  if (!commit.ok) {
    const reason =
      commit.status === 422 ? await commit.json().catch(() => null) : null;
    throw Error(
      reason !== null &&
        typeof reason === "object" &&
        "error" in reason &&
        reason.error === "secret_found"
        ? "artifact_scan_rejected"
        : "artifact_commit_unconfirmed",
    );
  }
  const receipt = (await commit.json()) as {
    itemId?: string;
    version?: number;
    sha256?: string;
    bytes?: number;
  };
  const fail = async () => {
    await store.change(
      record!.requestId,
      "commit_unconfirmed",
      "integrity_failed",
    );
    throw Error("library_integrity_failed");
  };
  if (
    !receipt.itemId ||
    !/^[A-Za-z0-9_-]+$/.test(receipt.itemId) ||
    !Number.isSafeInteger(receipt.version) ||
    receipt.version! < 1 ||
    receipt.sha256 !== libraryDigest(files) ||
    receipt.bytes !== files.reduce((n, f) => n + f.bytes.length, 0)
  )
    return fail();
  const embed = await lib.request(
    "POST",
    `/api/v1/items/${receipt.itemId}/embed`,
    { json: { version: receipt.version } },
  );
  if (!embed.ok) throw Error("artifact_verification_unavailable");
  const grant = (await embed.json()) as {
    url?: string;
    downloadUrl?: string;
    version?: number;
    entry?: string;
    files?: { path: string }[];
  };
  if (grant.version !== receipt.version || grant.entry !== entry) return fail();
  if (
    files.length > 1 &&
    (!Array.isArray(grant.files) ||
      canonicalSalaamWork(grant.files.map((f) => f.path).sort()) !==
        canonicalSalaamWork(files.map((f) => f.path).sort()))
  )
    return fail();
  for (const file of files) {
    let download = grant.downloadUrl;
    if (files.length > 1) {
      if (!grant.url) return fail();
      const viewer = new URL(grant.url),
        signature = viewer.searchParams.get("sig");
      if (!signature || viewer.pathname !== "/_view") return fail();
      download =
        viewer.origin +
        "/s/" +
        signature +
        "/" +
        file.path.split("/").map(encodeURIComponent).join("/") +
        "?download=1";
    }
    if (!download) return fail();
    const remote = await readContent(download);
    if (
      remote.length !== file.bytes.length ||
      evidenceHash(remote) !== file.sha256
    )
      return fail();
  }
  await store.change(record.requestId, "commit_unconfirmed", "committed", {
    receipt,
  });
  return (await store.get(scope.requestId, scope.tenantId, scope.principalId))!;
}

/** Reconstitute the externally citeable receipt only from our committed durable record. */
export function exportReceipt(record: ExportRecord) {
  if (record.status !== "committed") throw Error("artifact_export_unconfirmed");
  const manifest = verifyExecutionEvidence(record.manifest),
    files = exportFiles(record),
    metadata = files[0]!;
  const receipt = record.receipt as {
    itemId: string;
    version: number;
    sha256: string;
    bytes: number;
  };
  if (
    metadata.sha256 !== record.digest ||
    receipt.sha256 !== libraryDigest(files) ||
    receipt.bytes !== files.reduce((n, f) => n + f.bytes.length, 0)
  )
    throw Error("export_integrity_failed");
  const artifacts = record.bundle
    ? verifyArtifactBundle(record.bundle).artifacts
    : [];
  return ExecutionExportReceiptV1.parse({
    schema_version: "agentpod-execution-export/v1",
    export_id: record.requestId,
    external_source: manifest.binding.run.source,
    external_run_id: manifest.binding.run.id,
    board_id: manifest.task.board_id,
    card_id: manifest.task.card_id,
    stage_key: manifest.task.stage_key,
    principal_id: manifest.binding.principal_id,
    run_epoch: manifest.binding.run.epoch,
    manifest_sha256: metadata.sha256,
    manifest_bytes: metadata.bytes.length,
    artifact_kind: record.bundle
      ? "execution-artifact-bundle"
      : "execution-metadata-manifest",
    library: {
      item_id: receipt.itemId,
      version: receipt.version,
      sha256: receipt.sha256,
      bytes: receipt.bytes,
      entry: metadata.path,
    },
    artifact_files: artifacts.map((a) => {
      const file = files.find((f) => f.artifactId === a.id)!;
      return {
        artifact_id: a.id,
        file_id: {
          item_id: receipt.itemId,
          version: receipt.version,
          path: file.path,
        },
        path: file.path,
        sha256: file.sha256,
        bytes: file.bytes.length,
        disposition: a.disposition,
      };
    }),
    verification: "download-sha256-verified",
  });
}

/** Validate independently admitted immutable source bytes and their precise evidence joins. */
export function verifyArtifactBundle(value: unknown, requested?: string[]) {
  const bundle = ExecutionArtifactBundleV1.parse(value),
    seen = new Set<string>();
  let total = 0;
  verifyExecutionEvidence(bundle.evidence);
  for (const artifact of bundle.artifacts) {
    if (seen.has(artifact.id)) throw Error("duplicate_artifact");
    seen.add(artifact.id);
    const ref = bundle.evidence.artifacts.find((a) => a.id === artifact.id);
    if (
      !ref ||
      ref.session_id !== artifact.session_id ||
      ref.digest !== artifact.digest ||
      ref.bytes !== artifact.bytes ||
      ref.disposition !== artifact.disposition
    )
      throw Error("artifact_source_mismatch");
    const bytes = Buffer.from(artifact.content_base64, "base64");
    total += bytes.length;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw Error("source_artifact_not_utf8");
    }
    if (
      total > 4 * 1024 * 1024 ||
      bytes.length !== artifact.bytes ||
      bytes.toString("base64") !== artifact.content_base64 ||
      evidenceHash(bytes) !== artifact.digest
    )
      throw Error("source_artifact_integrity_failed");
  }
  if (
    requested &&
    (new Set(requested).size !== requested.length ||
      requested.length !== seen.size ||
      requested.some((id) => !seen.has(id)))
  )
    throw Error("artifact_selection_mismatch");
  return bundle;
}
export interface FrozenExportFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  artifactId?: string;
}
export function exportFiles(
  record: Pick<ExportRecord, "manifest" | "bundle">,
): FrozenExportFile[] {
  if (!record.bundle) {
    const bytes = manifestBytes(record.manifest);
    return [
      { path: "execution-evidence.json", bytes, sha256: evidenceHash(bytes) },
    ];
  }
  const bundle = verifyArtifactBundle(record.bundle);
  if (
    canonicalSalaamWork(bundle.evidence) !==
    canonicalSalaamWork(verifyExecutionEvidence(record.manifest))
  )
    throw Error("bundle_evidence_mismatch");
  const artifacts = bundle.artifacts
    .map((a) => ({
      artifactId: a.id,
      path: `artifacts/${a.id}.json`,
      bytes: Buffer.from(a.content_base64, "base64"),
      sha256: a.digest,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const metadata = {
    schema_version: "agentpod-execution-manifest/v1",
    evidence: bundle.evidence,
    artifact_files: bundle.artifacts
      .map((a) => ({
        artifact_id: a.id,
        session_id: a.session_id,
        path: `artifacts/${a.id}.json`,
        sha256: a.digest,
        bytes: a.bytes,
        disposition: a.disposition,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  const bytes = new TextEncoder().encode(canonicalSalaamWork(metadata));
  if (
    bytes.length + artifacts.reduce((n, a) => n + a.bytes.length, 0) >
    8 * 1024 * 1024
  )
    throw Error("export_bundle_too_large");
  return [
    { path: "execution-manifest.json", bytes, sha256: evidenceHash(bytes) },
    ...artifacts,
  ];
}
export function exportBytes(record: Pick<ExportRecord, "manifest" | "bundle">) {
  return exportFiles(record)[0]!.bytes;
}
export function libraryDigest(files: FrozenExportFile[]) {
  return files.length === 1
    ? files[0]!.sha256
    : evidenceHash(
        new TextEncoder().encode(
          JSON.stringify(
            [...files]
              .sort((a, b) => (a.path < b.path ? -1 : 1))
              .map((f) => [f.path, f.sha256]),
          ),
        ),
      );
}
