import { z } from "zod";
import { SalaamAuthority } from "./salaam-authority";
import { SuperpipelineRunId } from "./ids";

const noControls = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
const digest = z.string().length(64).regex(/^[a-f0-9]+$/);
// Superpipeline packages/contract/src/ids.ts owns these prefixes/base62 grammar.
// Bounds are this private transport's admission limits, not new product ID grammar.
const productId = (prefix: string) => z.string().max(128)
  .regex(new RegExp(`^${prefix}_[A-Za-z0-9]{6,}$`)).refine(noControls);
const WorkIdentity = z.object({
  board_id: productId("brd"),
  card_id: productId("card"),
  stage_key: z.string().min(1).max(128).refine(noControls),
  input_digest: digest,
  plan_digest: digest,
}).strict();
const WorkAuthority = SalaamAuthority.refine((binding) =>
  binding.run.source === "superpipeline" && SuperpipelineRunId.safeParse(binding.run.id).success &&
  Object.values(binding).every((value) => typeof value !== "string" || noControls(value)) &&
  noControls(binding.run.id), "Strict work requires a bound Superpipeline run");

/** Private authenticated control path only. Parsing does not grant work authority.
 * Digests name independently admitted bytes; callers must compute them from the
 * actual work input and explicit task plan, not echo fields supplied by a model.
 * This foundation is not advertised by any runtime or routed to execution yet.
 */
export const SalaamWorkBinding = z.object({
  binding: WorkAuthority,
  work: WorkIdentity,
}).strict();
export const SalaamWorkAdmission = SalaamWorkBinding.extend({
  version: z.literal(1),
  request_id: z.string().uuid(),
}).strict();
export type SalaamWorkBinding = z.infer<typeof SalaamWorkBinding>;
export type SalaamWorkAdmission = z.infer<typeof SalaamWorkAdmission>;

export type SalaamWorkCheck =
  | { ok: true; admission: SalaamWorkAdmission }
  | { ok: false; code: "invalid_work_admission" | "invalid_work_binding" |
      "invalid_work_record" | "work_authority_mismatch" | "work_input_mismatch" |
      "work_request_conflict" };

// Zod emits this closed schema in declared field order. No unknown JSON payloads,
// maps or numerical normalization are part of this equality boundary.
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Compare a NEW admission against an independently prepared trusted expectation.
 * The consumer must additionally verify fresh admission/lease, root ownership,
 * capability, resource stops and uncertainty before committing a task/grant.
 */
export function checkSalaamWorkAdmission(value: unknown, expected: unknown): SalaamWorkCheck {
  const admission = SalaamWorkAdmission.safeParse(value);
  if (!admission.success) return { ok: false, code: "invalid_work_admission" };
  const owner = SalaamWorkBinding.safeParse(expected);
  if (!owner.success) return { ok: false, code: "invalid_work_binding" };
  if (!same(admission.data.binding, owner.data.binding))
    return { ok: false, code: "work_authority_mismatch" };
  if (!same(admission.data.work, owner.data.work))
    return { ok: false, code: "work_input_mismatch" };
  return { ok: true, admission: admission.data };
}

/** Classify an exact saved request before fresh-mutation checks. This is not a
 * persistence layer, a new grant, or permission to read another root's receipt.
 * Callers retain principal/root-scoped read access and must atomically persist
 * original request bytes + task mapping. A new request, lease or run conflicts.
 */
export function checkSalaamWorkReplay(value: unknown, saved: unknown): SalaamWorkCheck {
  const admission = SalaamWorkAdmission.safeParse(value);
  if (!admission.success) return { ok: false, code: "invalid_work_admission" };
  const original = SalaamWorkAdmission.safeParse(saved);
  if (!original.success) return { ok: false, code: "invalid_work_record" };
  if (!same(admission.data, original.data)) return { ok: false, code: "work_request_conflict" };
  return { ok: true, admission: original.data };
}
