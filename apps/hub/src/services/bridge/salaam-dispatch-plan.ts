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
export function planFrom(context: RunContext) {
  const spec = context.card.spec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    throw Error("Strict Salaam work requires an explicit spec.salaam plan");
  // Each run works in its own directory and declares the agent's handoff (salaam-run-scope).
  return runScopedPlan(
    taskSpec.parse((spec as Record<string, unknown>).salaam).plan,
    context.run.runId,
  );
}
/** Extra strict progression steps for re-running a step; Salaam accepts steps or steps + this. */
export const SALAAM_RERUN_ALLOWANCE = 3;
