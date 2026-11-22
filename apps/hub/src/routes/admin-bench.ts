/**
 * Bench stages, as an operator surface — `fleet bench`.
 *
 *   GET    /api/admin/bench/stages            every stage in the workspace, with what its node serves
 *   POST   /api/admin/bench/stages            add one (BenchStageAddRequest)
 *   PATCH  /api/admin/bench/stages/:name      change one (BenchStageSetRequest)
 *   DELETE /api/admin/bench/stages/:name      remove one
 *
 * Mounted inside the admin guard (admin.ts): a stage decides which bench runs a board's work and
 * whose grants it spends, which is workspace administration. No response carries a clone URL, a
 * worker argument or a credential; the rules live in `services/bridge/bench-stages.ts`.
 */
import { Hono } from "hono";
import { BenchStageAddRequest, BenchStageSetRequest } from "@agentpod/contract";

import { resolveTenantId } from "../auth/tenant";
import { addBenchStage, listBenchStages, removeBenchStage, setBenchStage } from "../services/bridge";

async function bodyOf(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

const issues = (error: { issues: { path: PropertyKey[]; message: string }[] }) =>
  error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");

export const adminBenchRouter = new Hono()
  .get("/stages", async (c) => c.json(await listBenchStages(resolveTenantId(c))))
  .post("/stages", async (c) => {
    const parsed = BenchStageAddRequest.safeParse(await bodyOf(c.req.raw));
    if (!parsed.success) return c.json({ error: issues(parsed.error) }, 400);
    const out = await addBenchStage(c.get("user").id, resolveTenantId(c), parsed.data);
    return c.json(out.body, out.status);
  })
  .patch("/stages/:name", async (c) => {
    const parsed = BenchStageSetRequest.safeParse(await bodyOf(c.req.raw));
    if (!parsed.success) return c.json({ error: issues(parsed.error) }, 400);
    const out = await setBenchStage(c.get("user").id, resolveTenantId(c), c.req.param("name"), parsed.data);
    return c.json(out.body, out.status);
  })
  .delete("/stages/:name", async (c) => {
    const out = await removeBenchStage(c.get("user").id, resolveTenantId(c), c.req.param("name"));
    return c.json(out.body, out.status);
  });
