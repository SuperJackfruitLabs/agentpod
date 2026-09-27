import { nodeRefusal } from "../services/skill-operation-diagnostics";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { and, eq, gt, inArray } from "drizzle-orm";
import {
  SkillArtifactUploadQuery,
  SkillPlanRequest,
  SkillRollbackRequest,
  SkillApplyRequest,
  SkillVerifyParams,
  SkillVerifyResult,
  SkillRetentionResult,
  SkillMaintenanceResult,
  SkillMaintenanceApplyParams,
  SkillNativePlanRequest,
  SkillNativeVerifyResult,
  PluginPlanRequest,
  TrustedSkillReleaseImportRequest,
  SkillReleaseCanaryPlanRequest,
  SkillReleaseCanaryOperationRequest,
  SkillReleaseCanaryApplyRequest,
} from "@agentpod/contract";
import type { AuthUser } from "../auth/middleware";
import { db } from "../db/drizzle";
import { skillOperations } from "../db/schema/skills";
import { stations } from "../db/schema/stations";
import { user as users } from "../db/schema/auth";
import { verifyNodeCredential } from "../services/enrollment";
import { requireGrantReach } from "../services/grant-reach";
import { getStation } from "../services/station-registry";
import { gateCapability, refuseWithoutReach } from "./station-writes";
import {
  SkillRequestError,
  MAX_SKILL_ARTIFACT_BYTES,
  storeSkillArtifact,
  listSkillArtifacts,
  getSkillArtifact,
  deleteSkillArtifact,
  type SkillOwner,
} from "../services/skill-artifacts";
import {
  importTrustedSkillRelease,
  listTrustedSkillReleases,
} from "../services/trusted-skill-catalog";
import { createSkillReleaseCohort, listSkillReleaseCohorts } from "../services/skill-release-cohorts";
import { createSkillReleaseCanaryOperation, getSkillReleaseCanaryOperation } from "../services/skill-release-canary";
import { SkillReleaseCohortCreateRequest } from "@agentpod/contract";
import {
  createSkillOperation,
  getSkillOperation,
  executeSkillOperation,
  listSkillOperations,
  operationResult,
  MANAGED_PLUGIN,
} from "../services/skill-operations";
import * as broker from "../services/broker";
import { canaryOperationIdentity } from "./canary-operation";

function owner(c: Context): SkillOwner {
  const user = c.get("user") as AuthUser | undefined;
  if (!user || user.id === "anonymous")
    throw new SkillRequestError(401, "Unauthorized");
  return { userId: user.id, tenantId: user.tenantId };
}

async function stationContext(c: Context, mutate = false, capability = "skills.manage") {
  const caller = owner(c),
    station = await getStation(caller.userId, c.req.param("id")!);
  if (!station || station.tenantId !== caller.tenantId)
    throw new SkillRequestError(404, "Station not found");
  if (!gateCapability(station, capability))
    throw new SkillRequestError(
      403,
      capability === "skills.native"
        ? "Station does not advertise native skill activation"
        : capability === "plugins.manage"
          ? "Station does not advertise plugin management"
          : "Station does not advertise skill management",
    );
  if (mutate) {
    const refusal = await refuseWithoutReach(
      c,
      caller.userId,
      station,
      capability as "skills.manage" | "skills.native" | "plugins.manage",
    );
    if (refusal) return { refusal } as const;
  }
  return { caller, station } as const;
}

/** Bounded streaming reads also protect chunked uploads without Content-Length. */

/**
 * A node refusal the operator can act on, rather than a blanket bad gateway.
 *
 * `nodeRefusal` separates a conflict the node NAMED (409, carrying the reason)
 * from a transport failure where it never answered (502, the generic text
 * passed in here).
 */
function skillNodeRefusal(nodeError: string | undefined, unavailable: string) {
  const outcome = nodeRefusal(nodeError);
  return new SkillRequestError(
    outcome.status,
    outcome.status === 409 ? outcome.message : unavailable,
  );
}

export async function readSkillBody(
  request: Request,
  maxBytes: number,
  timeoutMs = 30_000,
): Promise<Buffer> {
  const length = request.headers.get("Content-Length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes))
    throw new SkillRequestError(413, "Request body exceeds limit");
  if (!request.body) throw new SkillRequestError(400, "Request body required");
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () =>
      reject(new SkillRequestError(400, "Request upload interrupted"));
    request.signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(cancel, timeoutMs);
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (request.signal.aborted)
      throw new SkillRequestError(400, "Request upload interrupted");
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new SkillRequestError(413, "Request body exceeds limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  if (
    !c.req.header("Content-Type")?.toLowerCase().startsWith("application/json")
  )
    throw new SkillRequestError(400, "JSON body required");
  const bytes = await readSkillBody(c.req.raw, 8192);
  try {
    return schema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new SkillRequestError(400, "Invalid request body");
  }
}
function routesBase() {
  return new Hono().onError((error, c) => {
    c.header("Cache-Control", "no-store");
    if (error instanceof SkillRequestError)
      return c.json({ error: error.message }, error.status);
    // Database exceptions may contain bound binary parameters. Do not log them.
    console.error("[skill-management] request failed", error.name);
    return c.json({ error: "Skill management request failed" }, 500);
  });
}
const authenticateSkillRequest: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store");
  owner(c);
  await next();
};

export function createSkillManagementRoutes(
  options: { timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 70_000;
  return routesBase()
    .use("/skills/*", authenticateSkillRequest)
    .use("/stations/:id/skills/*", authenticateSkillRequest)
    .use("/stations/:id/plugins/*", authenticateSkillRequest)
    .get("/skills/artifacts", async (c) =>
      c.json(await listSkillArtifacts(owner(c))),
    )
    .get("/skills/catalog/releases", async (c) =>
      c.json(await listTrustedSkillReleases(owner(c))),
    )
    .post("/skills/catalog/releases", async (c) => {
      const request = await body(c, TrustedSkillReleaseImportRequest);
      return c.json(
        await importTrustedSkillRelease(owner(c), request.record, request.artifacts),
        201,
      );
    })
    .get("/skills/catalog/cohorts", async (c) => c.json(await listSkillReleaseCohorts(owner(c))))
    .post("/skills/catalog/cohorts", async (c) =>
      c.json(await createSkillReleaseCohort(owner(c), await body(c, SkillReleaseCohortCreateRequest)), 201),
    )
    .post("/skills/catalog/cohorts/:cohortId/canary/plan", async (c) => {
      const caller = owner(c);
      const binding = await createSkillReleaseCanaryOperation(
        caller,
        c.req.param("cohortId"),
        await body(c, SkillReleaseCanaryPlanRequest),
      );
      const station = await getStation(caller.userId, binding.stationId);
      if (!station || station.tenantId !== caller.tenantId)
        throw new SkillRequestError(409, "Canary station is no longer available to this owner");
      const result = await executeSkillOperation(caller, station, binding.operationId, "plan", undefined, timeoutMs);
      return c.json({ ...binding, operation: result }, result.inFlight || result.state === "unknown" ? 202 : 200);
    })
    .post("/skills/catalog/cohorts/:cohortId/canary/operations/inspect", async (c) => {
      const caller = owner(c);
      const { station, operation } = await getSkillReleaseCanaryOperation(caller, c.req.param("cohortId"), await body(c, SkillReleaseCanaryOperationRequest));
      const result = await executeSkillOperation(caller, station, operation.id, "inspect", undefined, timeoutMs);
      return c.json(result, result.inFlight || result.state === "unknown" ? 202 : 200);
    })
    .post("/skills/catalog/cohorts/:cohortId/canary/operations/apply", async (c) => {
      const caller = owner(c);
      const request = await body(c, SkillReleaseCanaryApplyRequest);
      const { station, operation } = await getSkillReleaseCanaryOperation(
        caller,
        c.req.param("cohortId"),
        canaryOperationIdentity(request),
      );
      if (!station.capabilities?.includes("skills.manage"))
        throw new SkillRequestError(409, "Canary station does not advertise skill management");
      await requireGrantReach(caller.userId, station, "skills.manage", "mutate");
      const result = await executeSkillOperation(caller, station, operation.id, "apply", request.planDigest, timeoutMs);
      return c.json(result, result.inFlight || result.state === "unknown" ? 202 : 200);
    })
    .post("/skills/artifacts", async (c) => {
      const query = new URL(c.req.url).searchParams;
      if ([...query.keys()].some((key) => query.getAll(key).length !== 1))
        throw new SkillRequestError(400, "Duplicate artifact metadata");
      const parsed = SkillArtifactUploadQuery.safeParse(
        Object.fromEntries(query),
      );
      if (!parsed.success)
        throw new SkillRequestError(400, "Invalid artifact metadata");
      if (
        !["application/octet-stream", "application/gzip"].includes(
          c.req.header("Content-Type") ?? "",
        )
      )
        throw new SkillRequestError(400, "Binary artifact body required");
      const bytes = await readSkillBody(c.req.raw, MAX_SKILL_ARTIFACT_BYTES);
      return c.json(
        await storeSkillArtifact(owner(c), parsed.data, bytes),
        201,
      );
    })
    .delete("/skills/artifacts/:artifactId", async (c) => {
      const deleted = await deleteSkillArtifact(
        owner(c),
        c.req.param("artifactId"),
      );
      return deleted
        ? c.json({ deleted: true })
        : c.json(
            { error: "Artifact is missing or retained by an operation" },
            409,
          );
    })
    .post("/stations/:id/skills/plan", async (c) => {
      const ctx = await stationContext(c, true);
      if ("refusal" in ctx) return ctx.refusal;
      const request = await body(c, SkillPlanRequest),
        operation = await createSkillOperation(
          ctx.caller,
          ctx.station,
          request,
        );
      const result = await executeSkillOperation(
        ctx.caller,
        ctx.station,
        operation.id,
        "plan",
        undefined,
        timeoutMs,
      );
      return c.json(
        result,
        result.inFlight || result.state === "unknown" ? 202 : 200,
      );
    })
    .post("/stations/:id/skills/rollback", async (c) => {
      const ctx = await stationContext(c, true);
      if ("refusal" in ctx) return ctx.refusal;
      const request = await body(c, SkillRollbackRequest),
        operation = await createSkillOperation(
          ctx.caller,
          ctx.station,
        request,
        );
      const result = await executeSkillOperation(
        ctx.caller,
        ctx.station,
        operation.id,
        "plan",
        undefined,
        timeoutMs,
      );
      return c.json(
        result,
        result.inFlight || result.state === "unknown" ? 202 : 200,
      );
    })
    .post("/stations/:id/skills/native/plan", async (c) => {
      const ctx = await stationContext(c, true, "skills.native");
      if ("refusal" in ctx) return ctx.refusal;
      const request = await body(c, SkillNativePlanRequest);
      const operation = await createSkillOperation(ctx.caller, ctx.station, request);
      const result = await executeSkillOperation(ctx.caller, ctx.station, operation.id, "plan", undefined, timeoutMs, "native");
      return c.json(result, result.inFlight || result.state === "unknown" ? 202 : 200);
    })
    .get("/stations/:id/skills/native/operations", async (c) => {
      const ctx = await stationContext(c, false, "skills.native");
      if ("refusal" in ctx) return ctx.refusal;
      return c.json(await listSkillOperations(ctx.caller, ctx.station, "native"));
    })
    .get("/stations/:id/skills/native/operations/:operationId", async (c) => {
      const ctx = await stationContext(c, false, "skills.native");
      if ("refusal" in ctx) return ctx.refusal;
      return c.json(operationResult(await getSkillOperation(ctx.caller, ctx.station, c.req.param("operationId"), "native")));
    })
    .post("/stations/:id/skills/native/operations/:operationId/inspect", async (c) => {
      const ctx = await stationContext(c, false, "skills.native");
      if ("refusal" in ctx) return ctx.refusal;
      await body(c, z.object({}).strict());
      const result = await executeSkillOperation(ctx.caller, ctx.station, c.req.param("operationId"), "inspect", undefined, timeoutMs, "native");
      return c.json(result, result.inFlight || result.state === "unknown" ? 202 : 200);
    })
    // Plugin management (#553): the node plans enabling or disabling the one
    // plugin its apn embeds; the Console reviews and applies by digest. Reads
    // need only the capability; planning and applying need reach.
    .post("/stations/:id/plugins/plan", async (c) => {
      const ctx = await stationContext(c, true, "plugins.manage");
      if ("refusal" in ctx) return ctx.refusal;
      const request = await body(c, PluginPlanRequest);
      const operation = await createSkillOperation(ctx.caller, ctx.station, { ...request, plugin: MANAGED_PLUGIN });
      const result = await executeSkillOperation(ctx.caller, ctx.station, operation.id, "plan", undefined, timeoutMs, "plugin");
      return c.json(result, result.inFlight || result.state === "unknown" ? 202 : 200);
    })
    .get("/stations/:id/plugins/operations", async (c) => {
      const ctx = await stationContext(c, false, "plugins.manage");
      if ("refusal" in ctx) return ctx.refusal;
      return c.json(await listSkillOperations(ctx.caller, ctx.station, "plugin"));
    })
    .get("/stations/:id/plugins/operations/:operationId", async (c) => {
      const ctx = await stationContext(c, false, "plugins.manage");
      if ("refusal" in ctx) return ctx.refusal;
      return c.json(operationResult(await getSkillOperation(ctx.caller, ctx.station, c.req.param("operationId"), "plugin")));
    })
    .post("/stations/:id/plugins/operations/:operationId/inspect", async (c) => {
      const ctx = await stationContext(c, false, "plugins.manage");
      if ("refusal" in ctx) return ctx.refusal;
      await body(c, z.object({}).strict());
      const result = await executeSkillOperation(ctx.caller, ctx.station, c.req.param("operationId"), "inspect", undefined, timeoutMs, "plugin");
      return c.json(result, result.inFlight || result.state === "unknown" ? 202 : 200);
    })
    .post("/stations/:id/plugins/operations/:operationId/apply", async (c) => {
      const ctx = await stationContext(c, true, "plugins.manage");
      if ("refusal" in ctx) return ctx.refusal;
      const request = await body(c, SkillApplyRequest);
      const result = await executeSkillOperation(ctx.caller, ctx.station, c.req.param("operationId"), "apply", request.planDigest, timeoutMs, "plugin");
      return c.json(result, result.inFlight || result.state === "unknown" ? 202 : 200);
    })
    .get("/stations/:id/skills/operations", async (c) => {
      const ctx = await stationContext(c);
      if ("refusal" in ctx) return ctx.refusal;
      return c.json(await listSkillOperations(ctx.caller, ctx.station));
    })
    .get("/stations/:id/skills/operations/:operationId", async (c) => {
      const ctx = await stationContext(c);
      if ("refusal" in ctx) return ctx.refusal;
      return c.json(
        operationResult(
          await getSkillOperation(
            ctx.caller,
            ctx.station,
            c.req.param("operationId"),
          ),
        ),
      );
    })
    .post("/stations/:id/skills/operations/:operationId/inspect", async (c) => {
      const ctx = await stationContext(c);
      if ("refusal" in ctx) return ctx.refusal;
      await body(c, z.object({}).strict());
      const result = await executeSkillOperation(
        ctx.caller,
        ctx.station,
        c.req.param("operationId"),
        "inspect",
        undefined,
        timeoutMs,
      );
      return c.json(
        result,
        result.inFlight || result.state === "unknown" ? 202 : 200,
      );
    })
    .post("/stations/:id/skills/operations/:operationId/apply", async (c) => {
      const ctx = await stationContext(c, true);
      if ("refusal" in ctx) return ctx.refusal;
      const request = await body(c, SkillApplyRequest);
      const result = await executeSkillOperation(
        ctx.caller,
        ctx.station,
        c.req.param("operationId"),
        "apply",
        request.planDigest,
        timeoutMs,
      );
      return c.json(
        result,
        result.inFlight || result.state === "unknown" ? 202 : 200,
      );
    })
    .post("/stations/:id/skills/native/operations/:operationId/apply", async (c) => {
      const ctx = await stationContext(c, true, "skills.native");
      if ("refusal" in ctx) return ctx.refusal;
      const request = await body(c, SkillApplyRequest);
      const result = await executeSkillOperation(ctx.caller, ctx.station, c.req.param("operationId"), "apply", request.planDigest, timeoutMs, "native");
      return c.json(result, result.inFlight || result.state === "unknown" ? 202 : 200);
    })
    .post("/stations/:id/skills/verify", async (c) => {
      const ctx = await stationContext(c);
      if ("refusal" in ctx) return ctx.refusal;
      const request = await body(c, SkillVerifyParams.omit({ key: true }));
      const response = await broker.request(
        ctx.station.nodeId,
        "skills.verify",
        { key: ctx.station.stationKey, profile: request.profile },
        { timeoutMs },
      );
      const parsed = SkillVerifyResult.safeParse(response.data);
      if (
        !response.ok ||
        !parsed.success ||
        parsed.data.nodeId !== ctx.station.nodeId ||
        parsed.data.stationKey !== ctx.station.stationKey ||
        parsed.data.harness !== ctx.station.harness ||
        parsed.data.profile !== request.profile
      )
        throw new SkillRequestError(
          502,
          "Node verification is unavailable or invalid",
        );
      return c.json(parsed.data);
    })
    .post("/stations/:id/skills/retention", async (c) => {
      const ctx = await stationContext(c);
      if ("refusal" in ctx) return ctx.refusal;
      const request = await body(c, SkillVerifyParams.omit({ key: true }));
      const response = await broker.request(
        ctx.station.nodeId,
        "skills.retention",
        { key: ctx.station.stationKey, profile: request.profile },
        { timeoutMs },
      );
      const parsed = SkillRetentionResult.safeParse(response.data);
      if (
        !response.ok ||
        !parsed.success ||
        parsed.data.nodeId !== ctx.station.nodeId ||
        parsed.data.stationKey !== ctx.station.stationKey ||
        parsed.data.harness !== ctx.station.harness ||
        parsed.data.profile !== request.profile
      )
        throw skillNodeRefusal(response.error, "Node retention inspection is unavailable or invalid");
      return c.json(parsed.data);
    })
    .post("/stations/:id/skills/maintenance/plan", async (c) => {
      const ctx = await stationContext(c);
      if ("refusal" in ctx) return ctx.refusal;
      const request = await body(c, SkillVerifyParams.omit({ key: true }));
      const response = await broker.request(
        ctx.station.nodeId,
        "skills.maintenance.plan",
        { key: ctx.station.stationKey, profile: request.profile },
        { timeoutMs },
      );
      const parsed = SkillMaintenanceResult.safeParse(response.data);
      if (
        !response.ok ||
        !parsed.success ||
        parsed.data.nodeId !== ctx.station.nodeId ||
        parsed.data.stationKey !== ctx.station.stationKey ||
        parsed.data.harness !== ctx.station.harness ||
        parsed.data.profile !== request.profile
      ) throw skillNodeRefusal(response.error, "Node maintenance preview is unavailable or invalid");
      return c.json(parsed.data);
    })
    .post("/stations/:id/skills/maintenance/apply", async (c) => {
      const ctx = await stationContext(c, true);
      if ("refusal" in ctx) return ctx.refusal;
      const request = await body(c, SkillMaintenanceApplyParams.omit({ key: true }));
      const response = await broker.request(ctx.station.nodeId, "skills.maintenance.apply", { key: ctx.station.stationKey, profile: request.profile, expectedPlanDigest: request.expectedPlanDigest }, { timeoutMs });
      const parsed = SkillMaintenanceResult.safeParse(response.data);
      if (!response.ok || !parsed.success || parsed.data.nodeId !== ctx.station.nodeId || parsed.data.stationKey !== ctx.station.stationKey || parsed.data.harness !== ctx.station.harness || parsed.data.profile !== request.profile)
        throw skillNodeRefusal(response.error, "Node maintenance apply is unavailable or invalid");
      return c.json(parsed.data);
    })
    .post("/stations/:id/skills/native/verify", async (c) => {
      const ctx = await stationContext(c, false, "skills.native");
      if ("refusal" in ctx) return ctx.refusal;
      const request = await body(c, SkillVerifyParams.omit({ key: true }));
      const response = await broker.request(ctx.station.nodeId, "skills.native.verify", { key: ctx.station.stationKey, profile: request.profile }, { timeoutMs });
      const parsed = SkillNativeVerifyResult.safeParse(response.data);
      if (!response.ok || !parsed.success || parsed.data.nodeId !== ctx.station.nodeId || parsed.data.stationKey !== ctx.station.stationKey || parsed.data.harness !== ctx.station.harness || parsed.data.profile !== request.profile)
        throw new SkillRequestError(502, "Node native verification is unavailable or invalid");
      return c.json(parsed.data);
    });
}

// Node identity routes must mount before the browser-session middleware.
export const skillArtifactDownloadRoutes = routesBase().post(
  "/nodes/:nodeId/stations/:stationId/skill-artifacts/:operationId",
  async (c) => {
    c.header("Cache-Control", "no-store");
    const { nodeId, stationId, operationId } = c.req.param();
    const credential = /^Bearer\s+([^:]+):(.+)$/i.exec(
      c.req.header("Authorization") ?? "",
    );
    if (
      !credential ||
      credential[1] !== nodeId ||
      !(await verifyNodeCredential(nodeId!, credential[2]!).catch(() => false))
    )
      throw new SkillRequestError(401, "Invalid node credential");
    const [record] = await db
      .select({ operation: skillOperations, station: stations })
      .from(skillOperations)
      .innerJoin(
        stations,
        and(
          eq(stations.id, skillOperations.stationId),
          eq(stations.userId, skillOperations.userId),
          eq(stations.tenantId, skillOperations.tenantId),
        ),
      )
      .innerJoin(users, eq(users.id, skillOperations.userId))
      .where(
        and(
          eq(skillOperations.id, operationId!),
          eq(skillOperations.nodeId, nodeId!),
          eq(skillOperations.stationId, stationId!),
          eq(stations.nodeId, nodeId!),
          eq(stations.stationKey, c.req.header("X-AgentPod-Station-Key") ?? ""),
          eq(skillOperations.stationKey, stations.stationKey),
          eq(skillOperations.harness, stations.harness),
          eq(users.banned, false),
          eq(skillOperations.action, "install"),
          inArray(skillOperations.state, ["planning", "applying"]),
          gt(skillOperations.downloadUntil, new Date()),
          gt(skillOperations.leaseExpiresAt, new Date()),
        ),
      );
    if (!record?.operation.artifactId)
      throw new SkillRequestError(
        403,
        "No artifact authorization for this station operation",
      );
    try {
      await requireGrantReach(
        record.operation.userId,
        record.station,
        "skills.manage",
        "mutate",
      );
    } catch {
      throw new SkillRequestError(
        403,
        "No artifact authorization for this station operation",
      );
    }
    const artifact = await getSkillArtifact(
      { userId: record.operation.userId, tenantId: record.operation.tenantId },
      record.operation.artifactId,
    );
    if (
      !artifact ||
      artifact.profile !== record.operation.profile ||
      artifact.harness !== record.operation.harness
    )
      throw new SkillRequestError(
        403,
        "No artifact authorization for this station operation",
      );
    return new Response(new Uint8Array(artifact.bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(artifact.size),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
);
