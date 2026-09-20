import { createHash } from "node:crypto";
import { eq, and, or, isNull, lt, sql, desc } from "drizzle-orm";
import {
  SkillHubOperation,
  SkillHubOperationSummary,
  SkillInstallPlan,
  SkillInstallReceipt,
  SkillOperationResult,
} from "@agentpod/contract";
import { db } from "../db/drizzle";
import { skillOperations } from "../db/schema/skills";
import { stationAudit } from "../db/schema/audit";
import { tenantScope } from "../db/tenant-scope";
import {
  getSkillArtifactMetadata,
  SkillRequestError,
  type SkillOwner,
} from "./skill-artifacts";
import type { StationRow } from "./station-registry";
import * as broker from "./broker";

type Operation = typeof skillOperations.$inferSelect;
type Mode = "plan" | "apply" | "inspect";
const scope = (owner: SkillOwner, id?: string) =>
  tenantScope(
    skillOperations,
    owner.tenantId,
    eq(skillOperations.userId, owner.userId),
    id ? eq(skillOperations.id, id) : undefined,
  );
function operationStatus(
  row: Pick<Operation, "state" | "error" | "leaseToken" | "leaseExpiresAt">,
) {
  const inFlight =
    !!row.leaseToken && !!row.leaseExpiresAt && row.leaseExpiresAt > new Date();
  if (!inFlight && (row.state === "planning" || row.state === "applying")) {
    return {
      inFlight,
      state: "unknown" as const,
      error: "Hub worker lease expired; inspect the node operation",
    };
  }
  return { inFlight, state: row.state, error: row.error };
}
export function operationResult(row: Operation): SkillHubOperation {
  return SkillHubOperation.parse({
    id: row.id,
    stationId: row.stationId,
    nodeId: row.nodeId,
    stationKey: row.stationKey,
    harness: row.harness,
    profile: row.profile,
    action: row.action,
    artifactId: row.artifactId,
    ...operationStatus(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    plan: row.plan,
    receipt: row.receipt,
  });
}
export async function getSkillOperation(
  owner: SkillOwner,
  station: StationRow,
  id: string,
): Promise<Operation> {
  const [row] = await db
    .select()
    .from(skillOperations)
    .where(and(scope(owner, id), eq(skillOperations.stationId, station.id)));
  if (!row) throw new SkillRequestError(404, "Operation not found");
  if (
    row.nodeId !== station.nodeId ||
    row.stationKey !== station.stationKey ||
    row.harness !== station.harness
  )
    throw new SkillRequestError(
      409,
      "Station identity changed since this operation was created",
    );
  return row;
}
export async function listSkillOperations(
  owner: SkillOwner,
  station: StationRow,
): Promise<SkillHubOperationSummary[]> {
  // Plans can be large; history lists identifiers and status, not every diff.
  const rows = await db
    .select({
      id: skillOperations.id,
      stationId: skillOperations.stationId,
      nodeId: skillOperations.nodeId,
      stationKey: skillOperations.stationKey,
      harness: skillOperations.harness,
      profile: skillOperations.profile,
      action: skillOperations.action,
      artifactId: skillOperations.artifactId,
      state: skillOperations.state,
      error: skillOperations.error,
      leaseToken: skillOperations.leaseToken,
      leaseExpiresAt: skillOperations.leaseExpiresAt,
      createdAt: skillOperations.createdAt,
      updatedAt: skillOperations.updatedAt,
    })
    .from(skillOperations)
    .where(and(scope(owner), eq(skillOperations.stationId, station.id)))
    .orderBy(desc(skillOperations.createdAt))
    .limit(50);
  return rows.map(({ leaseToken, leaseExpiresAt, ...row }) =>
    SkillHubOperationSummary.parse({
      ...row,
      ...operationStatus({ ...row, leaseToken, leaseExpiresAt }),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }),
  );
}

export async function createSkillOperation(
  owner: SkillOwner,
  station: StationRow,
  request:
    | { requestId: string; artifactId: string }
    | { requestId: string; profile: string },
): Promise<Operation> {
  if (station.userId !== owner.userId || station.tenantId !== owner.tenantId)
    throw new SkillRequestError(404, "Station not found");
  const artifact =
    "artifactId" in request
      ? await getSkillArtifactMetadata(owner, request.artifactId)
      : null;
  if ("artifactId" in request && !artifact)
    throw new SkillRequestError(404, "Artifact not found");
  if (artifact && artifact.harness !== station.harness)
    throw new SkillRequestError(409, "Artifact targets a different harness");
  const action = artifact ? "install" : "rollback";
  const profile =
    artifact?.profile ?? ("profile" in request ? request.profile : "");
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        owner.tenantId,
        owner.userId,
        station.id,
        request.requestId.toLowerCase(),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["skill-operations", owner.tenantId, owner.userId, station.id])},0))`,
    );
    const [existing] = await tx
      .select()
      .from(skillOperations)
      .where(scope(owner, id));
    if (existing) {
      if (
        existing.stationId !== station.id ||
        existing.nodeId !== station.nodeId ||
        existing.stationKey !== station.stationKey ||
        existing.harness !== station.harness ||
        existing.profile !== profile ||
        existing.action !== action ||
        existing.artifactId !== (artifact?.id ?? null)
      )
        throw new SkillRequestError(
          409,
          "Request ID already belongs to a different operation",
        );
      return existing;
    }
    const [usage] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(skillOperations)
      .where(and(scope(owner), eq(skillOperations.stationId, station.id)));
    if (Number(usage?.count) >= (action === "install" ? 255 : 256))
      throw new SkillRequestError(
        409,
        "Station operation retention limit reached",
      );
    const [row] = await tx
      .insert(skillOperations)
      .values({
        id,
        ...owner,
        stationId: station.id,
        nodeId: station.nodeId,
        stationKey: station.stationKey,
        harness: station.harness,
        profile,
        action,
        artifactId: artifact?.id ?? null,
      })
      .returning();
    return row!;
  });
}

function checkedPlan(
  data: unknown,
  operation: Operation,
  pin: string | undefined,
): SkillInstallPlan {
  const parsed = SkillInstallPlan.safeParse(data);
  if (!parsed.success) throw new Error("invalid node plan");
  const plan = parsed.data,
    binding = plan.binding;
  if (
    plan.operationId !== operation.id ||
    plan.action !== operation.action ||
    binding.nodeId !== operation.nodeId ||
    binding.stationKey !== operation.stationKey ||
    binding.harness !== operation.harness ||
    binding.profile !== operation.profile ||
    (operation.action === "install" && plan.after?.archiveSHA256 !== pin) ||
    (operation.plan !== null &&
      JSON.stringify(plan) !==
        JSON.stringify(SkillInstallPlan.parse(operation.plan)))
  )
    throw new Error("foreign or changed node plan");
  return plan;
}
function checkedReceipt(
  data: unknown,
  operation: Operation,
  pin: string | undefined,
): SkillInstallReceipt {
  const receipt = SkillInstallReceipt.parse(data);
  checkedPlan(receipt.plan, operation, pin);
  return receipt;
}
function receiptState(receipt: SkillInstallReceipt): Operation["state"] {
  if (receipt.phase === "applied") return "applied";
  if (receipt.phase === "planned") return "planned";
  if (receipt.phase === "conflict") return "conflict";
  return "unknown";
}

/** A database lease prevents duplicate dispatch across hub processes. A stale
 * worker can never overwrite a newer observation: final writes match its token.
 * The node journal is the filesystem authority; every retry inspects it first. */
export async function executeSkillOperation(
  owner: SkillOwner,
  station: StationRow,
  id: string,
  mode: Mode,
  reviewedDigest?: string,
  timeoutMs = 70_000,
): Promise<SkillHubOperation> {
  const initial = await getSkillOperation(owner, station, id);
  if (
    mode === "apply" &&
    (!initial.plan || initial.plan.planDigest !== reviewedDigest)
  )
    throw new SkillRequestError(
      409,
      "Reviewed plan digest does not match this operation",
    );
  const artifact = initial.artifactId
    ? await getSkillArtifactMetadata(owner, initial.artifactId)
    : null;
  if (initial.action === "install" && !artifact)
    throw new SkillRequestError(409, "Operation artifact is unavailable");
  const token = crypto.randomUUID(),
    auditId = `audit_${crypto.randomUUID()}`,
    now = new Date();
  const operation = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(skillOperations)
      .set({
        leaseToken: token,
        leaseExpiresAt: new Date(now.getTime() + 180_000),
        updatedAt: now,
        ...(mode === "inspect"
          ? {}
          : {
              state:
                mode === "plan" ? ("planning" as const) : ("applying" as const),
              downloadUntil:
                initial.action === "install"
                  ? new Date(now.getTime() + 90_000)
                  : null,
            }),
      })
      .where(
        and(
          scope(owner, id),
          or(
            isNull(skillOperations.leaseToken),
            lt(skillOperations.leaseExpiresAt, now),
          ),
        ),
      )
      .returning();
    if (claimed && mode !== "inspect")
      await tx.insert(stationAudit).values({
        id: auditId,
        ...owner,
        nodeId: station.nodeId,
        stationKey: station.stationKey,
        verb: `skills.${mode === "plan" && initial.action === "rollback" ? "rollback" : mode}`,
        paramsSummary: {
          operationId: id,
          artifactId: initial.artifactId,
          action: initial.action,
        },
        result: "pending",
      });
    return claimed;
  });
  if (!operation)
    return operationResult(await getSkillOperation(owner, station, id));
  const params = {
    key: operation.stationKey,
    profile: operation.profile,
    operationId: id,
  };
  let outcome: Pick<Operation, "state" | "plan" | "receipt" | "error"> = {
    state: "unknown",
    plan: operation.plan,
    receipt: operation.receipt,
    error: "Node outcome is unknown; inspect the operation before retrying",
  };
  let auditOK = false;
  try {
    const inspection = await broker.request(
      operation.nodeId,
      "skills.operation",
      params,
      { timeoutMs },
    );
    if (!inspection.ok) throw new Error("node inspection unavailable");
    const observed = SkillOperationResult.parse(inspection.data).receipt;
    if (observed) {
      const receipt = checkedReceipt(
        observed,
        operation,
        artifact?.archiveSHA256,
      );
      outcome = {
        state: receiptState(receipt),
        plan: receipt.plan,
        receipt,
        error: receipt.error,
      };
    }
    if (mode === "inspect") {
      if (!observed)
        outcome.error = "The node has no receipt for this operation";
      auditOK = true;
    } else if (mode === "plan") {
      if (observed) {
        auditOK = true;
      } else {
        if (operation.plan)
          throw new Error("previously observed plan is absent");
        const reply = await broker.request(
          operation.nodeId,
          operation.action === "install" ? "skills.plan" : "skills.rollback",
          {
            ...params,
            ...(artifact
              ? { stationId: station.id, archiveSHA256: artifact.archiveSHA256 }
              : {}),
          },
          { timeoutMs },
        );
        if (!reply.ok) throw new Error("node plan unavailable");
        const plan = checkedPlan(
          reply.data,
          operation,
          artifact?.archiveSHA256,
        );
        outcome = { state: "planned", plan, receipt: null, error: null };
        auditOK = true;
      }
    } else {
      if (!observed) throw new Error("reviewed plan absent on node");
      if (observed.plan.planDigest !== reviewedDigest)
        throw new Error("node changed reviewed plan");
      if (observed.phase !== "applied") {
        const reply = await broker.request(
          operation.nodeId,
          "skills.apply",
          {
            ...params,
            stationId: station.id,
            expectedPlanDigest: reviewedDigest,
          },
          { timeoutMs },
        );
        if (!reply.ok) throw new Error("node application outcome unavailable");
        const receipt = checkedReceipt(
          reply.data,
          operation,
          artifact?.archiveSHA256,
        );
        outcome = {
          state: receiptState(receipt),
          plan: receipt.plan,
          receipt,
          error: receipt.error,
        };
      }
      auditOK = outcome.state === "applied";
    }
  } catch {
    // Broker failures and invalid output cannot establish that nothing changed.
    // Never persist a raw node error or a database query containing package bytes.
    outcome = {
      ...outcome,
      state: "unknown",
      error: "Node outcome is unknown; inspect the operation before retrying",
    };
  }
  const [saved] = await db
    .update(skillOperations)
    .set({
      ...outcome,
      leaseToken: null,
      leaseExpiresAt: null,
      downloadUntil: null,
      updatedAt: new Date(),
    })
    .where(and(scope(owner, id), eq(skillOperations.leaseToken, token)))
    .returning();
  if (mode !== "inspect")
    await db
      .update(stationAudit)
      .set({
        result: auditOK ? "ok" : "error",
        error: auditOK
          ? null
          : (outcome.error ?? "Operation did not confirm completion"),
      })
      .where(
        tenantScope(
          stationAudit,
          owner.tenantId,
          eq(stationAudit.id, auditId),
          eq(stationAudit.userId, owner.userId),
        ),
      );
  return operationResult(
    saved ?? (await getSkillOperation(owner, station, id)),
  );
}
