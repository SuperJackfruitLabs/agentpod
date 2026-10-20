/** Internal producer only. Not installed into the bridge until strict completion,
 * decision/recovery and observed runtime capability are implemented end to end. */
import { createHash } from "node:crypto";
import {
  SalaamWorkAdmission,
  type SalaamWorkBinding,
} from "../../../../packages/contract/src/salaam-work";
import {
  SalaamWorkInput,
  SalaamWorkPlan,
  canonicalSalaamWork,
} from "../../../../packages/contract/src/salaam-work-payload";

export function workDigest(value: unknown): string {
  return createHash("sha256").update(canonicalSalaamWork(value)).digest("hex");
}
/** Binding comes from makeSalaamExecution, input/plan from admitted board work.
 * Model metadata must never be used as the source of this internal call. */
export function prepareSalaamWork(
  requestId: string,
  binding: SalaamWorkBinding["binding"],
  identity: Pick<
    SalaamWorkBinding["work"],
    "board_id" | "card_id" | "stage_key"
  >,
  rawInput: unknown,
  rawPlan: unknown,
) {
  const input = SalaamWorkInput.parse(rawInput),
    plan = SalaamWorkPlan.parse(rawPlan);
  const admission = SalaamWorkAdmission.parse({
    version: 1,
    request_id: requestId,
    binding,
    work: {
      ...identity,
      input_digest: workDigest(input),
      plan_digest: workDigest(plan),
    },
  });
  return { admission, input, plan };
}
