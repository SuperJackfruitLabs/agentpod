/**
 * An agent's standing "Always allow" approval rules (approval scopes, part 2):
 *
 *   GET    /api/stations/:id/approval-rules              list the live rules (any workspace member)
 *   POST   /api/stations/:id/approval-rules              {scope} set one (workspace owner or admin)
 *   DELETE /api/stations/:id/approval-rules/:ruleId      revoke it (workspace owner or admin)
 *
 * A rule binds the station's current occupant; a station with no occupant cannot have one. Setting
 * the same scope twice returns the live rule. Revoking applies to runs in flight: Salaam drops the
 * rule at its next lease renewal. Lookup is tenant-scoped: another workspace's station is 404.
 */
import { Hono, type Context } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { agentApprovalRules as rules, type AgentApprovalRule } from "../db/schema/agent-approval-rules";
import { requireWorkspaceAdmin } from "../auth/workspace-authority";
import { recordAudit } from "../services/audit";
import { APPROVAL_RULE_SCOPES } from "../services/agent-approval-rules";
import type { AuthUser } from "../auth/middleware";

const SetBody = z.object({ scope: z.enum(APPROVAL_RULE_SCOPES) }).strict();

const view = (r: AgentApprovalRule) => ({
  id: r.id,
  scope: r.scope,
  setBy: r.createdBy,
  setAt: r.createdAt.toISOString(),
});

export function createAgentApprovalRuleRoutes() {
  const app = new Hono();

  async function station(c: Context) {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") return { error: c.json({ error: "unauthorized" }, 401) };
    const [row] = await db
      .select()
      .from(stations)
      .where(and(eq(stations.id, c.req.param("id")!), eq(stations.tenantId, user.tenantId)))
      .limit(1);
    if (!row) return { error: c.json({ error: "not-found", message: "No such station." }, 404) };
    return { user, row };
  }
  const live = (stationId: string, principalId: string) =>
    and(eq(rules.stationId, stationId), eq(rules.principalId, principalId), isNull(rules.revokedAt));

  app.get("/stations/:id/approval-rules", async (c) => {
    const s = await station(c);
    if ("error" in s) return s.error;
    if (!s.row.principalId) return c.json({ rules: [] });
    const rows = await db.select().from(rules).where(live(s.row.id, s.row.principalId));
    return c.json({ rules: rows.map(view) });
  });

  app.post("/stations/:id/approval-rules", async (c) => {
    const s = await station(c);
    if ("error" in s) return s.error;
    const denied = requireWorkspaceAdmin(c);
    if (denied) return denied;
    let parsed;
    try {
      parsed = SetBody.safeParse(await c.req.json());
    } catch {
      return c.json({ error: "bad-request", message: "Body must be JSON." }, 400);
    }
    if (!parsed.success) return c.json({ error: "bad-request", message: "Unknown scope or field." }, 400);
    if (!s.row.principalId)
      return c.json({ error: "no-occupant", message: "This station has no agent to set a rule for." }, 409);
    const [existing] = await db
      .select()
      .from(rules)
      .where(and(live(s.row.id, s.row.principalId), eq(rules.scope, parsed.data.scope)));
    if (existing) return c.json({ rule: view(existing) });
    const [created] = await db
      .insert(rules)
      .values({
        id: crypto.randomUUID(),
        tenantId: s.row.tenantId,
        stationId: s.row.id,
        principalId: s.row.principalId,
        scope: parsed.data.scope,
        createdBy: s.user.id,
      })
      .onConflictDoNothing()
      .returning();
    const rule =
      created ??
      (await db.select().from(rules).where(and(live(s.row.id, s.row.principalId), eq(rules.scope, parsed.data.scope))))[0]!;
    const audit = await recordAudit(db, {
      tenantId: s.row.tenantId,
      userId: s.user.id,
      nodeId: s.row.nodeId,
      stationKey: s.row.stationKey,
      verb: "approval-rule.set",
      params: { actor: s.user.id, ruleId: rule.id, scope: rule.scope },
    });
    await audit.done("ok");
    return c.json({ rule: view(rule) }, created ? 201 : 200);
  });

  app.delete("/stations/:id/approval-rules/:ruleId", async (c) => {
    const s = await station(c);
    if ("error" in s) return s.error;
    const denied = requireWorkspaceAdmin(c);
    if (denied) return denied;
    const [revoked] = await db
      .update(rules)
      .set({ revokedAt: new Date(), revokedBy: s.user.id })
      .where(and(eq(rules.id, c.req.param("ruleId")!), eq(rules.stationId, s.row.id), isNull(rules.revokedAt)))
      .returning();
    if (!revoked) return c.json({ error: "not-found", message: "No such live rule on this station." }, 404);
    const audit = await recordAudit(db, {
      tenantId: s.row.tenantId,
      userId: s.user.id,
      nodeId: s.row.nodeId,
      stationKey: s.row.stationKey,
      verb: "approval-rule.revoke",
      params: { actor: s.user.id, ruleId: revoked.id, scope: revoked.scope },
    });
    await audit.done("ok");
    return c.json({ revoked: true });
  });
  return app;
}
