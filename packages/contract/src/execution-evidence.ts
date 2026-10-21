import { z } from "zod";
import { SalaamAuthority } from "./salaam-authority";
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const opaque = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v));
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const state = id;
const nullableHash = hash.nullable();
/** Deliberately omits workspace; evidence never carries mutation authority. */
export const ExecutionEvidenceBinding = SalaamAuthority.omit({
  workspace: true,
}).strict();
const amounts = z
  .object({
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative(),
    cache_read_tokens: z.number().nonnegative(),
    cache_write_tokens: z.number().nonnegative(),
    cost_usd: z.number().nonnegative(),
  })
  .strict();
const observation = z
  .object({
    source_key: opaque,
    session_id: uuid,
    attempt_id: uuid.nullable(),
    provider: opaque,
    model: opaque,
    status: z.enum(["known", "estimated", "unknown"]),
    recorded_values: amounts.nullable(),
    observation_digest: nullableHash,
    digest_verified: z.literal(true).nullable(),
    token_provenance: z.enum(["ledger-recorded", "unknown"]),
    cost_provenance: z.enum(["ledger-recorded-not-provider-bill", "unknown"]),
  })
  .strict();
export const ExecutionUsageEvidence = z
  .object({
    version: z.literal(1),
    recorded_by: z.literal("salaam-usage-ledger"),
    session_id: uuid,
    includes_children: z.literal(true),
    status: z.enum(["known", "estimated", "unknown", "unreported", "partial"]),
    coverage: z
      .object({
        observations: count,
        recorded: count,
        unknown: count,
        estimated: count,
      })
      .strict(),
    recorded_subtotal: amounts.nullable(),
    cost_provenance: z.enum(["ledger-recorded-not-provider-bill", "unknown"]),
    truncated: z.boolean(),
    observations: z.array(observation).max(256),
  })
  .strict();
export const ExecutionToolkitResolutionEvidence = z
  .object({
    resolution_id: hash,
    call_revision: count,
    request_digest: hash,
    source: z.literal("operator-attestation"),
    outcome: z.enum(["succeeded", "failed_definite"]),
    evidence_digest: hash,
    native_state: z.enum([
      "outcome_acknowledged",
      "returned",
      "denied",
      "cancelled",
    ]),
    native_receipt_digest: hash,
    authority: z.literal(false),
    product_effect_verified: z.literal(false),
  })
  .strict();
const ExecutionToolCore = z
  .object({
    id: z.union([uuid, hash]),
    session_id: uuid,
    attempt_id: uuid.nullable(),
    task_check_id: uuid.nullable(),
    tool_call_id: opaque.nullable(),
    kind: id,
    state,
    input_digest: nullableHash,
    operation_id: uuid.nullable(),
    operation_digest: nullableHash,
    receipt_digest: nullableHash,
    resolution: opaque.nullable(),
  })
  .strict();
const ExecutionToolEvidence = z.discriminatedUnion("source", [
  ExecutionToolCore.extend({
    source: z.literal("operation"),
    resolution_evidence: z.null(),
  }).strict(),
  ExecutionToolCore.extend({
    source: z.literal("managed-http"),
    resolution_evidence: z.null(),
  }).strict(),
  ExecutionToolCore.extend({
    source: z.literal("managed-toolkit"),
    resolution_evidence: ExecutionToolkitResolutionEvidence.nullable(),
  }).strict(),
  ExecutionToolCore.extend({
    source: z.literal("station"),
    resolution_evidence: z.null(),
  }).strict(),
]);
/** Separate explicit opt-in transport; legacy C5 is unchanged. Salaam UUIDs never become Hub attempt IDs. */
export const ExecutionEvidenceV1 = z
  .object({
    schema_version: z.literal("salaam-execution-evidence/v1"),
    source: z.literal("salaam"),
    as_of: z.string().datetime(),
    binding: ExecutionEvidenceBinding,
    task: z
      .object({
        board_id: id,
        card_id: id,
        stage_key: id,
        task_id: uuid,
        request_id: uuid,
        session_id: uuid,
        state,
        plan_revision: count,
        input_digest: hash,
        plan_digest: hash,
      })
      .strict(),
    fingerprints: z
      .array(
        z
          .object({
            session_id: uuid,
            worker_epoch: count,
            version: z.literal(1),
            harness: z.literal("salaam"),
            harness_version: opaque,
            pi_version: opaque,
            bundle_digest: hash,
            policy_digest: hash,
            provider: opaque,
            model: opaque,
            context_digest: hash,
            context_admission_digest: nullableHash,
            verification: z.literal("pinned-readiness-handshake"),
            digest: hash,
          })
          .strict(),
      )
      .max(256),
    attempts: z
      .array(
        z
          .object({
            id: uuid,
            session_id: uuid,
            worker_epoch: count.nullable(),
            state,
          })
          .strict(),
      )
      .max(256),
    children: z
      .array(
        z
          .object({
            id: uuid,
            parent_session: uuid,
            parent_attempt: uuid.nullable(),
            child_session: uuid,
            child_attempt: uuid.nullable(),
            state,
            input_digest: hash,
            artifact_id: uuid.nullable(),
            contributor_principal_id: id.nullable(),
          })
          .strict(),
      )
      .max(256),
    tools: z.array(ExecutionToolEvidence).max(256),
    checks: z
      .array(
        z
          .object({
            id: uuid,
            task_id: uuid,
            step_id: id.nullable(),
            plan_revision: count,
            workspace_digest: hash,
            profile_digest: hash,
            engine_id: id,
            state,
            artifact_id: uuid.nullable(),
          })
          .strict(),
      )
      .max(256),
    integrations: z
      .array(
        z
          .object({
            id: uuid,
            parent_session: uuid,
            child_id: uuid,
            patch_digest: hash,
            before_digest: hash,
            after_artifact: uuid.nullable(),
            state,
            mutation_id: uuid.nullable(),
          })
          .strict(),
      )
      .max(256),
    artifacts: z
      .array(
        z
          .object({
            id: uuid,
            session_id: uuid,
            digest: hash,
            bytes: count,
            disposition: z.enum([
              "observed",
              "proposed",
              "produced",
              "integrated",
            ]),
          })
          .strict(),
      )
      .max(256),
    usage: ExecutionUsageEvidence,
    contributors: z
      .object({
        principal_ids: z.array(id).max(256),
        closure: z.enum(["complete", "incomplete", "unknown"]),
      })
      .strict(),
    coverage: z
      .object({
        truncated: z
          .array(
            z.enum([
              "attempts",
              "children",
              "tools",
              "checks",
              "integrations",
              "artifacts",
              "fingerprints",
            ]),
          )
          .max(7),
        unavailable: z
          .array(
            z.enum([
              "attempts",
              "children",
              "tools",
              "checks",
              "integrations",
              "artifacts",
              "usage",
              "contributors",
              "fingerprints",
            ]),
          )
          .max(9),
      })
      .strict(),
  })
  .strict();
export type ExecutionEvidenceV1 = z.infer<typeof ExecutionEvidenceV1>;

export const AgentPodExecutionEvidenceResponse = z
  .object({
    schema_version: z.literal("agentpod-execution-evidence/v1"),
    external_source: id,
    external_run_id: id,
    board_id: id.nullable(),
    card_id: id.nullable(),
    executions: z.array(ExecutionEvidenceV1).max(256),
    as_of: z.string().datetime(),
  })
  .strict();
export type AgentPodExecutionEvidenceResponse = z.infer<
  typeof AgentPodExecutionEvidenceResponse
>;

/** Library verified immutable metadata manifest, not proof of arbitrary artifact contents. */
export const ExecutionExportReceiptV1 = z
  .object({
    schema_version: z.literal("agentpod-execution-export/v1"),
    export_id: uuid,
    external_source: z.literal("superpipeline"),
    external_run_id: id,
    board_id: id,
    card_id: id,
    stage_key: id,
    principal_id: id,
    run_epoch: count,
    manifest_sha256: hash,
    manifest_bytes: count,
    artifact_kind: z.enum([
      "execution-metadata-manifest",
      "execution-artifact-bundle",
    ]),
    library: z
      .object({
        item_id: id,
        version: z.number().int().positive(),
        sha256: hash,
        bytes: count,
        entry: z.enum(["execution-evidence.json", "execution-manifest.json"]),
      })
      .strict(),
    artifact_files: z
      .array(
        z
          .object({
            artifact_id: uuid,
            file_id: z
              .object({
                item_id: id,
                version: z.number().int().positive(),
                path: z.string().min(1).max(128),
              })
              .strict(),
            path: z.string().min(1).max(128),
            sha256: hash,
            bytes: count,
            disposition: z.enum(["proposed", "produced", "integrated"]),
          })
          .strict(),
      )
      .max(16),
    verification: z.literal("download-sha256-verified"),
  })
  .strict();
export type ExecutionExportReceiptV1 = z.infer<typeof ExecutionExportReceiptV1>;

/** Private source transport only: byte admission is explicit and bounded by Hub verification. */
export const ExecutionArtifactBundleV1 = z
  .object({
    schema_version: z.literal("salaam-execution-artifacts/v1"),
    evidence: ExecutionEvidenceV1,
    artifacts: z
      .array(
        z
          .object({
            id: uuid,
            session_id: uuid,
            digest: hash,
            bytes: count,
            disposition: z.enum(["proposed", "produced", "integrated"]),
            content_base64: z
              .string()
              .max(5592408)
              .regex(
                /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
              ),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export type ExecutionArtifactBundleV1 = z.infer<
  typeof ExecutionArtifactBundleV1
>;
