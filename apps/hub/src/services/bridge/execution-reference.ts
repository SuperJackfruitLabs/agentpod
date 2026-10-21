import type {
  ExportRecord,
  ExportStore,
} from "../superlibrary/execution-export";
import { exportReceipt } from "../superlibrary/execution-export";
import { readBridgeRoster, bridgePlaneCredential } from "./roster";
import { isBridgeEnabled } from "./config";
import { fetchAdapter, SuperpipelineClient } from "./superpipeline";
import { ExecutionEvidenceV1 } from "../../../../../packages/contract/src/execution-evidence";
/** Artifact success is independent of the optional Pipeline reference. New principals,
 * replacement station occupants, and legacy credentials are never fallback owners. */
export async function attachExecutionReference(
  store: ExportStore,
  record: ExportRecord,
  agentKey: string,
): Promise<"attached_unverified" | "unavailable"> {
  const prior = record.receipt as {
    reference?: { reference_id: string; verification: string };
  };
  if (prior.reference?.verification === "unverified")
    return "attached_unverified";
  if (!isBridgeEnabled()) return "unavailable";
  const baseUrl = (process.env.SUPERPIPELINE_BASE_URL ?? "").trim();
  if (!baseUrl) return "unavailable";
  try {
    const proof = exportReceipt(record),
      manifest = ExecutionEvidenceV1.parse(record.manifest);
    const roster = await readBridgeRoster(record.tenantId);
    const agent = roster.find(
      (a) =>
        a.key === agentKey &&
        a.boardId === proof.board_id &&
        a.stationId === manifest.binding.station_id &&
        a.credentialSource?.principalId === proof.principal_id &&
        a.credentialSource?.organizationId === manifest.binding.organization_id,
    );
    if (!agent?.credentialSource) return "unavailable";
    const client = new SuperpipelineClient({
      baseUrl,
      boardId: proof.board_id,
      token: "",
      credential: bridgePlaneCredential(agent),
      fetch: fetchAdapter,
    });
    const reference = await client.addEvidenceReference(proof.external_run_id, {
      leaseEpoch: proof.run_epoch,
      cardId: proof.card_id,
      stageKey: proof.stage_key,
      export_id: proof.export_id,
      manifest_sha256: proof.manifest_sha256,
    });
    await store.change(record.requestId, "committed", "committed", {
      receipt: { ...(record.receipt as object), reference },
    });
    return "attached_unverified";
  } catch {
    return "unavailable";
  }
}
