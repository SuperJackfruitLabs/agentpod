import {
  verifyArtifactBundle,
  verifyExecutionEvidence,
} from "../superlibrary/execution-export";
import { and, eq } from "drizzle-orm";
import {
  ExecutionEvidenceBinding,
  SalaamWorkPayload,
  canonicalSalaamWork,
} from "../../../../../packages/contract/src/index";
import { db } from "../../db/drizzle";
import { salaamWorkOwners } from "../../db/schema/salaam-work";
import { acpSessions } from "../../db/schema/acp";
import * as broker from "../broker";
/** Historical reads use original durable scope, never current station occupancy or lease renewal. */
async function readExecutionSnapshot(
  tenant: string,
  source: string,
  runId: string,
  board: string,
  card: string,
  artifactIds: string[] = [],
) {
  const [owner] = await db
    .select()
    .from(salaamWorkOwners)
    .where(
      and(
        eq(salaamWorkOwners.tenantId, tenant),
        eq(salaamWorkOwners.externalSource, source),
        eq(salaamWorkOwners.externalRunId, runId),
      ),
    );
  if (!owner) return null;
  const payload = SalaamWorkPayload.parse(owner.payload);
  const [session] = await db
    .select()
    .from(acpSessions)
    .where(
      and(
        eq(acpSessions.id, owner.sessionId),
        eq(acpSessions.tenantId, tenant),
      ),
    );
  const original = payload.admission.binding;
  if (
    !session?.executionAuthority ||
    canonicalSalaamWork(session.executionAuthority.binding) !==
      canonicalSalaamWork(original) ||
    original.run.source !== source ||
    original.run.id !== runId
  )
    throw Error("execution_owner_mismatch");
  const result = await broker.request(
    original.node_id,
    artifactIds.length
      ? "salaam.work-evidence-artifacts"
      : "salaam.work-evidence",
    artifactIds.length
      ? { binding: original, artifact_ids: artifactIds }
      : { binding: original },
  );
  if (!result.ok) throw Error("execution_evidence_unavailable");
  const bundle = artifactIds.length
    ? verifyArtifactBundle(result.data, artifactIds)
    : null;
  const evidence = verifyExecutionEvidence(
    bundle ? bundle.evidence : result.data,
  );
  const { workspace: _workspace, ...safe } = original;
  if (
    canonicalSalaamWork(evidence.binding) !==
    canonicalSalaamWork(ExecutionEvidenceBinding.parse(safe))
  )
    throw Error("execution_binding_mismatch");
  const work = payload.admission.work;
  const receipt = owner.receipt as {
    task_id?: string;
    session_id?: string;
  } | null;
  if (
    !receipt ||
    evidence.task.task_id !== receipt.task_id ||
    evidence.task.session_id !== receipt.session_id ||
    evidence.task.session_id !== session.executionAuthority.sessionId
  )
    throw Error("execution_task_mismatch");
  if (
    evidence.task.request_id !== owner.requestId ||
    evidence.task.board_id !== board ||
    evidence.task.card_id !== card ||
    evidence.task.stage_key !== work.stage_key ||
    evidence.task.input_digest !== work.input_digest ||
    evidence.task.plan_digest !== work.plan_digest
  )
    throw Error("execution_work_mismatch");
  return { evidence, bundle };
}

export async function readExecutionEvidence(
  tenant: string,
  source: string,
  runId: string,
  board: string,
  card: string,
) {
  const result = await readExecutionSnapshot(
    tenant,
    source,
    runId,
    board,
    card,
  );
  return result ? [result.evidence] : [];
}
export async function readExecutionArtifactBundle(
  tenant: string,
  source: string,
  runId: string,
  board: string,
  card: string,
  artifactIds: string[],
) {
  const result = await readExecutionSnapshot(
    tenant,
    source,
    runId,
    board,
    card,
    artifactIds,
  );
  if (!result?.bundle) throw Error("execution_artifacts_unavailable");
  return result.bundle;
}
