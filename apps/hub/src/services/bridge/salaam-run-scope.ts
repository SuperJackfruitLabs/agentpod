import { posix } from "node:path";
import type { z } from "zod";
import { SalaamWorkPlan } from "../../../../../packages/contract/src/salaam-work-payload";

type Plan = z.infer<typeof SalaamWorkPlan>;

/** The handoff the agent writes for the next stage; reported with Salaam's verification. */
export const HANDOFF_FILE = "handoff.json";

/** One directory per board run, so a check can never pass on files an earlier run left. */
export function runDirectory(runId: string): string {
  if (!/^run_[A-Za-z0-9]{6,}$/.test(runId)) throw Error("Strict work needs a plain run id");
  return "runs/" + runId;
}

/**
 * Scope a card's strict plan to its run's own directory: every deliverable and check runs
 * inside it, and the agent's handoff file becomes a declared deliverable, so Salaam verifies it
 * with the rest. Deterministic for a run id, so a resumed run reproduces its admitted digest.
 */
export function runScopedPlan(plan: Plan, runId: string): Plan {
  const dir = runDirectory(runId);
  const inside = (path: string) => (path === "." ? dir : posix.join(dir, path));
  const deliverables = [...plan.deliverables, HANDOFF_FILE].filter(
    (path, n, all) => all.indexOf(path) === n,
  );
  return SalaamWorkPlan.parse({
    ...plan,
    constraints: [
      `Work only inside ${dir}/ in the workspace, and create it first. Every path in this plan, ` +
        `including each check's directory and every deliverable, is relative to ${dir}/.`,
      `Before you finish, write ${dir}/${HANDOFF_FILE}: one JSON object for the next stage, with ` +
        `"summary" (what you did and found), "findings", "acceptance" (each criterion and how ` +
        `it was met) and "evidence" (sources and checks). It is verified and reported with your work.`,
      ...plan.constraints,
    ],
    acceptance: plan.acceptance.map((check) => scopedCheck(check, inside(check.cwd))),
    deliverables: deliverables.map(inside),
  });
}

/** A station check only runs at the workspace root (cwd "."), so the run's directory is entered
 * by the command itself. The directory is single-quoted; one that holds a quote is refused. */
function scopedCheck(check: Plan["acceptance"][number], dir: string): Plan["acceptance"][number] {
  if (!/^[A-Za-z0-9._/-]+$/.test(dir)) throw Error("Strict check directory must be a plain path");
  return { ...check, cwd: ".", command: `cd '${dir}' && (${check.command})` };
}
