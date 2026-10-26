import { z } from "zod";
import { SalaamWorkAdmission } from "./salaam-work";

const text = (max: number) => z.string().min(1).max(max);
const key = text(64).regex(/^[a-zA-Z0-9_-]+$/);
const path = text(512).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.split("/").length <= 16 &&
    value
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          !/^\.(git|salaam)(?:$|[.-])/i.test(part),
      ),
);
const limit = (max: number) => z.number().int().min(1).max(max);
const check = z
  .object({
    key,
    command: text(4096),
    cwd: z.union([z.literal("."), path]),
  })
  .strict();
/** Fully expanded subset of Salaam TaskPlan. No implicit defaults: a changed
 * daemon default cannot silently alter the admitted plan digest. */
export const SalaamWorkPlan = z
  .object({
    objective: text(4096),
    constraints: z.array(text(2048)).max(16),
    steps: z
      .array(
        z
          .object({
            key,
            title: text(256),
            instruction: text(4096),
            depends_on: z.array(key).max(31),
            checks: z.array(key).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    acceptance: z.array(check).max(8),
    /** Item 8: checks required at completion (run as `hook-<key>`) and an optional critic rubric.
     * Present only when declared, so a plan without one keeps its digest. */
    completion_gate: z
      .object({
        /** The built-in reviewer judges the verified deliverables against this rubric. */
        critic: z.object({ rubric: text(4096) }).strict().nullable(),
        hooks: z.array(check).max(8),
      })
      .strict()
      .refine((g) => g.critic !== null || g.hooks.length > 0, "An empty completion gate")
      .optional(),
    deliverables: z.array(path).max(32),
    limits: z
      .object({
        requests: limit(1024),
        runtime_ms: limit(86400000),
        concurrency: limit(8),
        token_units: limit(1073741824).nullable(),
        input_token_bound: limit(1048576),
        output_token_bound: limit(8192).nullable(),
        verification_runs: limit(256),
        invocations: limit(64).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const fail = () =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid task dependency, check, deliverable or budget",
      });
    const checks = new Set(plan.acceptance.map((c) => c.key));
    const hooks = (plan.completion_gate?.hooks ?? []).map((h) => "hook-" + h.key);
    if (
      checks.size !== plan.acceptance.length ||
      new Set(hooks).size !== hooks.length ||
      hooks.some((h) => checks.has(h)) ||
      new Set(plan.deliverables).size !== plan.deliverables.length ||
      (plan.limits.token_units !== null &&
        plan.limits.output_token_bound === null)
    )
      fail();
    const seen = new Set<string>();
    for (const step of plan.steps) {
      if (
        seen.has(step.key) ||
        new Set(step.depends_on).size !== step.depends_on.length ||
        step.depends_on.some((d) => !seen.has(d)) ||
        new Set(step.checks).size !== step.checks.length ||
        step.checks.some((c) => !checks.has(c))
      )
        fail();
      seen.add(step.key);
    }
  });
export const SalaamWorkInput = z
  .object({
    instructions: text(65536),
    references: z.array(text(4096)).max(64),
    incoming_handoff: z.string().max(65536).nullable(),
  })
  .strict();
export const SalaamWorkPayload = z
  .object({
    admission: SalaamWorkAdmission,
    input: SalaamWorkInput,
    plan: SalaamWorkPlan,
  })
  .strict();
export type SalaamWorkPayload = z.infer<typeof SalaamWorkPayload>;

/** Same recursively sorted-key JSON encoder as Salaam protocol.ts. Input must
 * already have passed a closed JSON schema. Array order is meaningful. */
export function canonicalSalaamWork(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalSalaamWork).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalSalaamWork(v)}`)
      .join(",")}}`;
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint" ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    throw Error("Invalid canonical work JSON");
  return JSON.stringify(value);
}
