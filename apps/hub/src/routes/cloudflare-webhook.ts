import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createLogger } from "../utils/logger";
import { db } from "../db/drizzle";
import { resolveTenantForUser } from "../auth/tenant";
import { cloudflareSandboxes } from "../db/schema/cloudflare";
import { eq } from "drizzle-orm";

const log = createLogger("cloudflare-webhook");

const webhookPayloadSchema = z.object({
  event: z.enum([
    "sandbox.created",
    "sandbox.started",
    "sandbox.stopped",
    "sandbox.hibernated",
    "sandbox.woken",
    "sandbox.deleted",
    "sandbox.error",
    "session.created",
    "session.message",
    "workspace.synced",
    "workflow.execution.started",
    "workflow.execution.step_completed",
    "workflow.execution.completed",
    "workflow.execution.failed",
  ]),
  data: z.object({
    sandboxId: z.string().optional(),
    userId: z.string().optional(),
    provider: z.string().optional(),
    sessionId: z.string().optional(),
    error: z.string().optional(),
    executionId: z.string().optional(),
    workflowId: z.string().optional(),
    stepId: z.string().optional(),
    stepName: z.string().optional(),
    status: z.string().optional(),
    result: z.record(z.unknown()).optional(),
    durationMs: z.number().optional(),
  }),
  timestamp: z.string(),
});

export const cloudflareWebhookRoutes = new Hono()
  .post(
    "/webhook",
    zValidator("json", webhookPayloadSchema),
    async (c) => {
      const body = c.req.valid("json");

      log.info("Received Cloudflare webhook", { event: body.event, sandboxId: body.data.sandboxId });

      try {
        switch (body.event) {
          case "sandbox.created":
            if (body.data.sandboxId) await handleSandboxCreated({ sandboxId: body.data.sandboxId, userId: body.data.userId });
            break;

          case "sandbox.hibernated":
            if (body.data.sandboxId) await handleSandboxHibernated({ sandboxId: body.data.sandboxId });
            break;

          case "sandbox.woken":
            if (body.data.sandboxId) await handleSandboxWoken({ sandboxId: body.data.sandboxId });
            break;

          case "sandbox.deleted":
            if (body.data.sandboxId) await handleSandboxDeleted({ sandboxId: body.data.sandboxId });
            break;

          case "sandbox.error":
            if (body.data.sandboxId) await handleSandboxError({ sandboxId: body.data.sandboxId, error: body.data.error });
            break;

          case "session.message":
            if (body.data.sandboxId) await handleSessionMessage({ sandboxId: body.data.sandboxId, sessionId: body.data.sessionId });
            break;

          case "workspace.synced":
            if (body.data.sandboxId) await handleWorkspaceSynced({ sandboxId: body.data.sandboxId });
            break;

          case "workflow.execution.started":
            if (body.data.executionId) await handleWorkflowExecutionStarted(body.data);
            break;

          case "workflow.execution.step_completed":
            if (body.data.executionId) await handleWorkflowStepCompleted(body.data);
            break;

          case "workflow.execution.completed":
            if (body.data.executionId) await handleWorkflowExecutionCompleted(body.data);
            break;

          case "workflow.execution.failed":
            if (body.data.executionId) await handleWorkflowExecutionFailed(body.data);
            break;

          default:
            log.debug("Unhandled webhook event", { event: body.event });
        }

        return c.json({ received: true });
      } catch (error) {
        log.error("Webhook processing failed", { event: body.event, error });
        return c.json({ error: "Webhook processing failed" }, 500);
      }
    }
  );

async function handleSandboxCreated(data: { sandboxId: string; userId?: string }) {
  if (!data.userId) {
    log.warn("sandbox.created missing userId", { sandboxId: data.sandboxId });
    return;
  }

  const existing = await db
    .select()
    .from(cloudflareSandboxes)
    .where(eq(cloudflareSandboxes.id, data.sandboxId))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(cloudflareSandboxes).values({
      tenantId: await resolveTenantForUser(data.userId),
      id: data.sandboxId,
      userId: data.userId,
      status: "running",
      workerUrl: "",
      lastActiveAt: new Date(),
    });
    log.info("Created cloudflare sandbox record", { sandboxId: data.sandboxId });
  } else {
    await db
      .update(cloudflareSandboxes)
      .set({
        status: "running",
        lastActiveAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(cloudflareSandboxes.id, data.sandboxId));
  }
}

async function handleSandboxHibernated(data: { sandboxId: string }) {
  const now = new Date();

  await db
    .update(cloudflareSandboxes)
    .set({
      status: "sleeping",
      updatedAt: now,
    })
    .where(eq(cloudflareSandboxes.id, data.sandboxId));

  log.info("Sandbox hibernated", { sandboxId: data.sandboxId });
}

async function handleSandboxWoken(data: { sandboxId: string }) {
  const now = new Date();

  await db
    .update(cloudflareSandboxes)
    .set({
      status: "running",
      lastActiveAt: now,
      updatedAt: now,
    })
    .where(eq(cloudflareSandboxes.id, data.sandboxId));

  log.info("Sandbox woken", { sandboxId: data.sandboxId });
}

async function handleSandboxDeleted(data: { sandboxId: string }) {
  await db.delete(cloudflareSandboxes).where(eq(cloudflareSandboxes.id, data.sandboxId));

  log.info("Sandbox deleted", { sandboxId: data.sandboxId });
}

async function handleSandboxError(data: { sandboxId: string; error?: string }) {
  await db
    .update(cloudflareSandboxes)
    .set({
      status: "error",
      updatedAt: new Date(),
      metadata: data.error ? { lastError: data.error } : undefined,
    })
    .where(eq(cloudflareSandboxes.id, data.sandboxId));

  log.error("Sandbox error", { sandboxId: data.sandboxId, error: data.error });
}

async function handleSessionMessage(data: { sandboxId: string; sessionId?: string }) {
  const now = new Date();

  await db
    .update(cloudflareSandboxes)
    .set({
      lastActiveAt: now,
      updatedAt: now,
    })
    .where(eq(cloudflareSandboxes.id, data.sandboxId));

  log.debug("Session message received", { sandboxId: data.sandboxId, sessionId: data.sessionId });
}

async function handleWorkspaceSynced(data: { sandboxId: string }) {
  await db
    .update(cloudflareSandboxes)
    .set({
      workspaceSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(cloudflareSandboxes.id, data.sandboxId));

  log.info("Workspace synced", { sandboxId: data.sandboxId });
}

// Workflow event handlers are no-ops: the workflowExecutions table was removed
// as part of the OpenCode schema retirement (P2b T3).
async function handleWorkflowExecutionStarted(data: { executionId?: string; workflowId?: string }) {
  log.debug("Workflow execution event ignored (OpenCode retired)", { executionId: data.executionId });
}

async function handleWorkflowStepCompleted(data: { executionId?: string; stepId?: string; stepName?: string }) {
  log.debug("Workflow step event ignored (OpenCode retired)", { executionId: data.executionId, stepId: data.stepId });
}

async function handleWorkflowExecutionCompleted(data: { executionId?: string; workflowId?: string; durationMs?: number }) {
  log.debug("Workflow execution event ignored (OpenCode retired)", { executionId: data.executionId });
}

async function handleWorkflowExecutionFailed(data: { executionId?: string; workflowId?: string; error?: string }) {
  log.debug("Workflow execution event ignored (OpenCode retired)", { executionId: data.executionId });
}
