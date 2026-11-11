/** What a strict Salaam run is selected by, and the plan it is admitted with. */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { tenantScope } from "../../db/tenant-scope";
import { SalaamWorkPlan } from "../../../../../packages/contract/src/salaam-work-payload";
import * as broker from "../broker";
import type { StrictWorkSelection } from "./dispatch-types";
import { runScopedPlan } from "./salaam-run-scope";
import type { RunContext } from "./superpipeline";

export async function probeSalaamWork(input: {
  stationId: string;
  /** The bridge agent's workspace; the station is read only there (W4). */
  tenantId: string;
  userId: string;
}): Promise<StrictWorkSelection> {
  const [station] = await db
    .select()
    .from(stations)
    .where(tenantScope(stations, input.tenantId, eq(stations.id, input.stationId)));
  if (!station || station.harness !== "salaam")
    return { required: false, version: null };
  const response = await broker.request(
    station.nodeId,
    "salaam.work-capability",
    {
      node_id: station.nodeId,
      station_key: station.stationKey,
      workspace: station.workspacePath,
    },
  );
  const parsed = z
    .object({ version: z.literal(1), enabled: z.literal(true) })
    .strict()
    .safeParse(response.ok ? response.data : null);
  return parsed.success
    ? { required: true, version: 1 }
    : {
        required: true,
        version: null,
        reason: "Salaam strict work version 1 is not freshly available",
      };
}
const taskSpec = z
  .object({ version: z.literal(1), plan: SalaamWorkPlan })
  .strict();

/**
 * The card cannot run on a strict Salaam station as written: its `spec.salaam` plan is missing or
 * invalid. Permanent for this card until a person edits it, so the start path parks the card on a
 * person instead of handing the claim back to be claimed again (staging, 2026-11-10: 230 times).
 */
export class SalaamPlanRefused extends Error {
  override name = "SalaamPlanRefused";
}

/** By name as well as instance: errors cross boundaries that drop the prototype. */
export function isSalaamPlanRefused(err: unknown): err is SalaamPlanRefused {
  return (
    err instanceof SalaamPlanRefused ||
    (typeof err === "object" && err !== null && "name" in err && err.name === "SalaamPlanRefused")
  );
}

const NEEDS_PLAN =
  "This card has no spec.salaam plan. A Salaam station runs only cards whose spec carries " +
  "salaam: { version: 1, plan }. Add one, then resume the card.";

export function planFrom(context: RunContext) {
  const spec = context.card.spec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new SalaamPlanRefused(NEEDS_PLAN);
  const salaam = (spec as Record<string, unknown>).salaam;
  if (salaam === undefined) throw new SalaamPlanRefused(NEEDS_PLAN);
  const parsed = taskSpec.safeParse(salaam);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${["spec.salaam", ...i.path.map(String)].join(".")}: ${i.message}`)
      .join("; ");
    throw new SalaamPlanRefused(`This card's spec.salaam plan is not valid (${where}). Fix it, then resume the card.`);
  }
  // Each run works in its own directory and declares the agent's handoff (salaam-run-scope).
  return runScopedPlan(parsed.data.plan, context.run.runId);
}
/** Extra strict progression steps for re-running a step; Salaam accepts steps or steps + this. */
export const SALAAM_RERUN_ALLOWANCE = 3;
