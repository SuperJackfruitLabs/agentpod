import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ExecutionArtifactBundleV1 } from "../../../../../packages/contract/src/execution-evidence";
import type { SalaamWorkCompletion } from "../../../../../packages/contract/src/salaam-work-completion";
import type { SuperlibraryCaller } from "../superlibrary/client";
import {
  exportReceipt,
  reserveExecutionExport,
  runExecutionExport,
  type ExportStore,
} from "../superlibrary/execution-export";
import { HANDOFF_FILE, runDirectory } from "./salaam-run-scope";

/** One deliverable as the handoff reports it: verified bytes, and where they were published. */
export interface PublishedDeliverable {
  path: string;
  sha256: string;
  url?: string;
  libraryFile?: string;
}
export interface SalaamPublication {
  /** The handoff the agent wrote, from the verified revision. */
  agent: Record<string, unknown>;
  deliverables: PublishedDeliverable[];
  /** "published" with a library item; "none" when only the handoff was declared; "unavailable"
   * when no Library is configured, which the handoff states rather than hides. */
  publication: "published" | "none" | "unavailable";
  library?: { item_id: string; url: string; export_id: string };
  /** Salaam's recorded usage for this work, from the same evidence read; telemetry only. */
  usage?: unknown;
}
export interface PublishDeps {
  /** Exact, integrity-checked bytes of these artifacts from the original owner (work-evidence-artifacts). */
  readBundle(artifactIds: string[]): Promise<ExecutionArtifactBundleV1>;
  library: SuperlibraryCaller | null;
  /** The Library app's origin; an item lives at `${appUrl}/a/${itemId}`. */
  appUrl: string | null;
  store: ExportStore;
  readContent(url: string): Promise<Uint8Array>;
  /** Idempotent card reference upsert. */
  addReference(input: { url: string; title: string }): Promise<void>;
}

const MAX_HANDOFF_BYTES = 64 * 1024;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (a: ExecutionArtifactBundleV1["artifacts"][number]) =>
  Buffer.from(a.content_base64, "base64");

/** A stable export id per work request, so every retry reuses one upload. */
export function deliverableExportId(workRequestId: string): string {
  const h = sha256(new TextEncoder().encode("salaam-deliverables\n" + workRequestId));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The agent's handoff file: a JSON object, or its text as a summary. Reserved keys are ours. */
export function agentHandoff(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.length > MAX_HANDOFF_BYTES) throw Error("Agent handoff exceeds 64 KiB");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { summary: text };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { summary: text };
  const { verification: _v, deliverables: _d, publication: _p, ...own } = value as Record<string, unknown>;
  return own;
}

function completionRecord(bundle: ExecutionArtifactBundleV1, id: string) {
  const artifact = bundle.artifacts.find((a) => a.id === id);
  if (!artifact || bundle.artifacts.length !== 1) throw Error("Completion record unavailable");
  const record = JSON.parse(bytesOf(artifact).toString("utf8")) as { deliverables?: unknown };
  const list = Array.isArray(record.deliverables) ? record.deliverables : null;
  if (!list?.length) throw Error("Completion names no deliverables");
  return list.map((d) => {
    const { path, sha256: digest, artifact_id } = (d ?? {}) as Record<string, unknown>;
    if (typeof path !== "string" || typeof digest !== "string" || typeof artifact_id !== "string")
      throw Error("Completion deliverable lacks verified bytes");
    return { path, sha256: digest, artifactId: artifact_id };
  });
}

/**
 * Publish a verified strict completion: read the completion record Salaam wrote, read each
 * deliverable's bytes from the verified revision (never the live workspace), check every one
 * against the digest the completion recorded, take the agent's own handoff from its handoff
 * file, and upload the other deliverables to SuperLibrary through the integrity-checked export,
 * linking the item from the card so the work record links it.
 */
export async function publishSalaamWork(
  deps: PublishDeps,
  scope: { workRequestId: string; tenantId: string; principalId: string; runId: string; title: string },
  completion: SalaamWorkCompletion,
): Promise<SalaamPublication> {
  const dir = runDirectory(scope.runId);
  const declared = completionRecord(await deps.readBundle([completion.completion_id]), completion.completion_id);
  const ids = declared.map((d) => d.artifactId);
  if (ids.length > 16) throw Error("More than 16 deliverables cannot be published at once");
  const bundle = await deps.readBundle(ids);
  const verified = declared.map((d) => {
    const artifact = bundle.artifacts.find((a) => a.id === d.artifactId);
    if (!artifact) throw Error("Deliverable bytes unavailable: " + d.path);
    const bytes = bytesOf(artifact);
    if (sha256(bytes) !== d.sha256) throw Error("Deliverable bytes differ from verification: " + d.path);
    return { ...d, bytes, relative: posix.relative(dir, d.path) };
  });
  const handoff = verified.find((d) => d.path === posix.join(dir, HANDOFF_FILE));
  if (!handoff) throw Error("The agent's handoff was not verified");
  const agent = agentHandoff(handoff.bytes);
  const usage = bundle.evidence.usage;
  const outputs = verified.filter((d) => d !== handoff);
  const listed = outputs.map((d) => ({ path: d.relative, sha256: d.sha256 }));
  if (!outputs.length) return { agent, deliverables: [], publication: "none", usage };
  if (!deps.library || !deps.appUrl)
    return { agent, deliverables: listed, publication: "unavailable", usage };

  const exportScope = {
    requestId: deliverableExportId(scope.workRequestId),
    tenantId: scope.tenantId,
    principalId: scope.principalId,
  };
  // A saved export is reused as it is: the evidence read again carries a new as_of.
  if (!(await deps.store.get(exportScope.requestId, exportScope.tenantId, exportScope.principalId))) {
    const selected = await deps.readBundle(outputs.map((d) => d.artifactId));
    await reserveExecutionExport(deps.store, { ...exportScope, manifest: selected.evidence, bundle: selected });
  }
  const record = await runExecutionExport(deps.store, exportScope, deps.library, deps.readContent, {
    title: scope.title,
  });
  const receipt = exportReceipt(record);
  const url = `${deps.appUrl.replace(/\/+$/, "")}/a/${receipt.library.item_id}`;
  await deps.addReference({ url, title: scope.title });
  return {
    agent,
    usage,
    publication: "published",
    library: { item_id: receipt.library.item_id, url, export_id: receipt.export_id },
    deliverables: outputs.map((d) => ({
      path: d.relative,
      sha256: d.sha256,
      url,
      libraryFile: receipt.artifact_files.find((f) => f.artifact_id === d.artifactId)?.path,
    })),
  };
}
