/** Hub-owned identity validation and durable node admission. Provider auth is unrelated. */
import { and, eq, sql } from "drizzle-orm";
import {
  SalaamAuthority,
  SalaamAuthorityStatus,
  type SalaamRunAuthority,
} from "@agentpod/contract";
import { db } from "../db/drizzle";
import { acpSessions, type StoredSalaamExecution } from "../db/schema/acp";
import { stations } from "../db/schema/stations";
import { tenants } from "../db/schema/tenants";
import { bridgeDispatches } from "../db/schema/bridge";
import { orgPlaneClient } from "./org-plane/client";
import * as broker from "./broker";

export async function validateSalaamAuthority(
  binding: SalaamAuthority,
  userId: string,
): Promise<void> {
  const [station] = await db
    .select()
    .from(stations)
    .where(eq(stations.id, binding.station_id));
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, station?.tenantId ?? ""));
  if (
    !station ||
    station.userId !== userId ||
    station.harness !== "salaam" ||
    station.nodeId !== binding.node_id ||
    station.stationKey !== binding.station_key ||
    station.workspacePath !== binding.workspace ||
    station.principalId !== binding.principal_id ||
    station.occupancyEpoch !== binding.occupancy_epoch ||
    tenant?.externalSource !== "org-plane" ||
    tenant.externalId !== binding.organization_id
  )
    throw Error(
      "Salaam execution authority no longer matches the station occupant, organization or generation",
    );
  // This is a background admission/renewal on behalf of an owner, not a token-bearing door.
  // Fresh reads are required: the display directory's stale cache cannot renew execution.
  const [agent, owner] = await Promise.all([
    orgPlaneClient().getPrincipal(binding.principal_id),
    orgPlaneClient().getPrincipal(userId),
  ]);
  if (
    !agent ||
    agent.kind !== "agent" ||
    agent.suspended ||
    agent.organizationId !== binding.organization_id ||
    !owner ||
    owner.suspended ||
    owner.organizationId !== binding.organization_id ||
    !owner.grant?.mayDispatch.includes(binding.principal_id)
  )
    throw Error(
      "Salaam execution authority was suspended or its dispatch grant was withdrawn",
    );
  if (binding.run.source === "superpipeline") {
    const [run] = await db
      .select()
      .from(bridgeDispatches)
      .where(
        and(
          eq(bridgeDispatches.externalSource, "superpipeline"),
          eq(bridgeDispatches.externalRunId, binding.run.id),
          eq(bridgeDispatches.tenantId, station.tenantId),
        ),
      );
    if (
      !run ||
      run.stationId !== station.id ||
      run.leaseEpoch !== binding.run.epoch ||
      run.outcome !== "working"
    )
      throw Error("Salaam work-run authority is stale");
  } else if (
    binding.run.id !== binding.hub_session_id ||
    binding.run.epoch !== 1
  )
    throw Error("Invalid interactive Salaam run authority");
}

export async function makeSalaamExecution(
  stationId: string,
  userId: string,
  sessionId: string,
  run?: SalaamRunAuthority,
): Promise<StoredSalaamExecution> {
  const [station] = await db
    .select()
    .from(stations)
    .where(eq(stations.id, stationId));
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, station?.tenantId ?? ""));
  const binding = SalaamAuthority.parse({
    version: 1,
    organization_id:
      tenant?.externalSource === "org-plane" ? tenant.externalId : null,
    principal_id: station?.principalId,
    node_id: station?.nodeId,
    station_id: stationId,
    station_key: station?.stationKey,
    occupancy_epoch: station?.occupancyEpoch,
    hub_session_id: sessionId,
    workspace: station?.workspacePath,
    run: run ?? { source: "agentpod", id: sessionId, epoch: 1 },
  });
  await validateSalaamAuthority(binding, userId);
  if (binding.run.source === "superpipeline") {
    const [current] = await db
      .select()
      .from(bridgeDispatches)
      .where(
        and(
          eq(bridgeDispatches.externalSource, "superpipeline"),
          eq(bridgeDispatches.externalRunId, binding.run.id),
          eq(bridgeDispatches.tenantId, station!.tenantId),
        ),
      );
    if (!current) throw Error("Salaam work-run ledger is unavailable");
    // A fresh claim on a different station must still reconcile this Hub's old execution.
    const prior = await db
      .select({ session: acpSessions })
      .from(acpSessions)
      .innerJoin(
        bridgeDispatches,
        sql`${bridgeDispatches.externalRunId} = ${acpSessions.executionAuthority} #>> '{binding,run,id}' AND ${bridgeDispatches.externalSource} = 'superpipeline' AND ${bridgeDispatches.tenantId} = ${acpSessions.tenantId}`,
      )
      .where(
        and(
          eq(bridgeDispatches.tenantId, current.tenantId),
          eq(bridgeDispatches.boardId, current.boardId),
          eq(bridgeDispatches.externalCardId, current.externalCardId),
          sql`${acpSessions.executionAuthority}->>'state' != 'revoked'`,
        ),
      );
    for (const { session } of prior) {
      const status = await revokeSalaamExecution(
        session.id,
        "Reconcile prior work-card execution",
      );
      if (status?.state !== "revoked")
        throw Error(
          "Prior Salaam work-card execution has not been confirmed stopped",
        );
    }
  }
  return {
    binding,
    leaseSequence: 0,
    sessionId: null,
    admissionId: null,
    stopRequestId: "revoke:" + sessionId,
    state: "active",
  };
}

export async function admitSalaamExecution(
  id: string,
  userId: string,
): Promise<StoredSalaamExecution> {
  const [row] = await db
    .select()
    .from(acpSessions)
    .where(eq(acpSessions.id, id));
  const saved = row?.executionAuthority;
  if (!saved || saved.state !== "active")
    throw Error("Salaam execution is not active");
  await validateSalaamAuthority(saved.binding, userId);
  const result = await broker.request(saved.binding.node_id, "salaam.admit", {
    binding: saved.binding,
    request_id: "admit:" + id,
  });
  if (!result.ok)
    throw Error(
      "Salaam node admission failed: " + (result.error ?? "node unavailable"),
    );
  const status = SalaamAuthorityStatus.parse(result.data);
  if (JSON.stringify(status.binding) !== JSON.stringify(saved.binding)) {
    // Compare schemas' normalized key order, never a different node's acknowledgement.
    if (
      JSON.stringify(SalaamAuthority.parse(status.binding)) !==
      JSON.stringify(SalaamAuthority.parse(saved.binding))
    )
      throw Error("Salaam admission receipt names another binding");
  }
  const next = {
    ...saved,
    sessionId: status.session_id,
    admissionId: status.admission_id,
    receipt: status,
  };
  await db
    .update(acpSessions)
    .set({ executionAuthority: next })
    .where(
      and(
        eq(acpSessions.id, id),
        sql`${acpSessions.executionAuthority}->>'state' = 'active'`,
      ),
    );
  return next;
}

export async function renewSalaamExecution(
  id: string,
  userId: string,
): Promise<StoredSalaamExecution | null> {
  const [row] = await db
    .select()
    .from(acpSessions)
    .where(eq(acpSessions.id, id));
  if (!row?.executionAuthority) return null;
  if (row.executionAuthority.state !== "active" || row.status === "ended")
    throw Error("Salaam execution is stopping");
  await validateSalaamAuthority(row.executionAuthority.binding, userId);
  const [claimed] = await db
    .update(acpSessions)
    .set({
      executionAuthority: sql`jsonb_set(${acpSessions.executionAuthority},'{leaseSequence}',to_jsonb((${acpSessions.executionAuthority}->>'leaseSequence')::bigint+1))`,
    })
    .where(
      and(
        eq(acpSessions.id, id),
        sql`${acpSessions.executionAuthority}->>'state' = 'active'`,
      ),
    )
    .returning();
  const saved = claimed?.executionAuthority;
  if (!saved) throw Error("Salaam execution changed during renewal");
  const result = await broker.request(saved.binding.node_id, "salaam.renew", {
    binding: saved.binding,
    request_id: `renew:${id}:${saved.leaseSequence}`,
    lease_sequence: saved.leaseSequence,
  });
  if (!result.ok)
    throw Error(
      "Salaam execution lease could not be renewed: " +
        (result.error ?? "node unavailable"),
    );
  const status = SalaamAuthorityStatus.parse(result.data);
  if (
    !status.authorized ||
    status.session_id !== saved.sessionId ||
    status.admission_id !== saved.admissionId ||
    JSON.stringify(SalaamAuthority.parse(status.binding)) !==
      JSON.stringify(SalaamAuthority.parse(saved.binding))
  )
    throw Error("Salaam renewal receipt differs from its saved admission");
  const next = { ...saved, receipt: status };
  const updated = await db
    .update(acpSessions)
    .set({ executionAuthority: next })
    .where(
      and(
        eq(acpSessions.id, id),
        sql`${acpSessions.executionAuthority}->>'state' = 'active'`,
        sql`(${acpSessions.executionAuthority}->>'leaseSequence')::bigint = ${saved.leaseSequence}`,
      ),
    )
    .returning({ id: acpSessions.id });
  if (!updated.length)
    throw Error("Salaam authority changed while renewal was in flight");
  return next;
}

export async function revokeSalaamExecution(
  id: string,
  reason: string,
): Promise<StoredSalaamExecution | null> {
  const [row] = await db
    .select()
    .from(acpSessions)
    .where(eq(acpSessions.id, id));
  const saved = row?.executionAuthority;
  if (!saved) return null;
  if (saved.state === "revoked") return saved;
  const pending: StoredSalaamExecution = {
    ...saved,
    state: "revocation_pending",
  };
  await db
    .update(acpSessions)
    .set({ executionAuthority: pending })
    .where(eq(acpSessions.id, id));
  const result = await broker.request(saved.binding.node_id, "salaam.revoke", {
    binding: saved.binding,
    request_id: saved.stopRequestId,
    reason: "AgentPod ended this execution",
  });
  // Failure is durable as pending; closing ACP cannot stand in for revocation.
  if (!result.ok) return pending;
  const status = SalaamAuthorityStatus.parse(result.data);
  if (
    JSON.stringify(SalaamAuthority.parse(status.binding)) !==
      JSON.stringify(SalaamAuthority.parse(saved.binding)) ||
    !status.revoked
  )
    throw Error("Salaam revocation was not acknowledged for this binding");
  const next: StoredSalaamExecution = {
    ...pending,
    receipt: status,
    state:
      status.owned_execution_stopped &&
      status.unresolved_operations.length === 0
        ? "revoked"
        : "revocation_pending",
  };
  await db
    .update(acpSessions)
    .set({ executionAuthority: next })
    .where(eq(acpSessions.id, id));
  return next;
}

export async function salaamStationStopped(
  stationId: string,
): Promise<boolean> {
  const [station] = await db
    .select()
    .from(stations)
    .where(eq(stations.id, stationId));
  const rows = await db
    .select()
    .from(acpSessions)
    .where(sql`${acpSessions.executionAuthority} IS NOT NULL`);
  for (const row of rows) {
    const execution = row.executionAuthority!;
    if (
      execution.binding.station_id !== stationId &&
      (!station?.principalId ||
        execution.binding.principal_id !== station.principalId)
    )
      continue;
    if (execution.state === "active" && row.status !== "ended") return false;
    if (execution.state !== "revoked") {
      const status = await revokeSalaamExecution(
        row.id,
        "Reconcile pending revocation",
      );
      if (status?.state !== "revoked") return false;
    }
  }
  return true;
}

export async function inspectSalaamExecution(saved: StoredSalaamExecution) {
  const result = await broker.request(saved.binding.node_id, "salaam.status", {
    binding: saved.binding,
    request_id: "status:" + saved.binding.hub_session_id,
  });
  if (!result.ok) throw Error("Salaam execution status is unavailable");
  const status = SalaamAuthorityStatus.parse(result.data);
  if (
    status.session_id !== saved.sessionId ||
    status.admission_id !== saved.admissionId ||
    JSON.stringify(SalaamAuthority.parse(status.binding)) !==
      JSON.stringify(SalaamAuthority.parse(saved.binding))
  )
    throw Error("Salaam status names another admission");
  return status;
}
