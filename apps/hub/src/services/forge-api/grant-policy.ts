/**
 * A grant's policy (preset, rules, GraphQL): checked, saved in one UPDATE that keeps the state,
 * then sent to a node that holds the credential. Not a lifecycle transition.
 */
import { ForgeApiPreset as ForgeApiPresetSchema, ForgeApiRule as ForgeApiRuleSchema, VERB_PARAMS, VERB_RESULTS } from "@agentpod/contract";
import type { ForgeApiPreset, ForgeApiRule } from "@agentpod/contract";
import { and, eq, inArray } from "drizzle-orm";

import { stationForgeApiGrants as g, type ForgeGrantState } from "../../db/schema/forge-api-grants";
import { ForgeApiGrantError } from "./errors";
import { withGrantClaim } from "./grant-claim";
import { isWriteGrant, loadGrant, loadStation, sameUserRequired, scrub, untrusted } from "./grant-common";
import { log } from "./grant-log";
import { toRef, type BrokerReply, type ForgeApiDeps, type Grant, type Ref, type StationRow } from "./grant-types";

// ─── policy ───────────────────────────────────────────────────────────────────

export interface UpdatePolicyInput extends Ref {
  preset: ForgeApiPreset;
  rules: ForgeApiRule[];
  allowGraphql: boolean;
  /** Acknowledge a write policy in same-user mode; recorded with `actor`. */
  acknowledgeSameUser?: boolean;
  actor?: string;
}

export interface PolicyResult {
  /**
   * applied: the node confirmed. stored: the node has no credential yet; the next deliver carries
   * it. policy-pending: saved, the node has not confirmed (reconcile re-sends it).
   */
  outcome: "applied" | "stored" | "policy-pending";
  grant: Grant;
}

const RULE_TARGET = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|\*) \/\S*$/;

/** Syntax only. The real check is stk's at reload; this rejects the obviously malformed. */
function checkPolicy(input: UpdatePolicyInput): void {
  const bad = (why: string) => new ForgeApiGrantError("bad-policy", `forge policy: ${why}.`, input.grantId);
  if (!ForgeApiPresetSchema.safeParse(input.preset).success) throw bad("unknown preset");
  if (typeof input.allowGraphql !== "boolean") throw bad("allowGraphql must be a boolean");
  if (!Array.isArray(input.rules)) throw bad("rules must be a list");
  input.rules.forEach((rule, i) => {
    if (!ForgeApiRuleSchema.safeParse(rule).success) throw bad(`rule ${i} has unknown fields or wrong types`);
    const targets = [rule.allow, rule.deny].filter((t) => t !== undefined);
    if (targets.length !== 1) throw bad(`rule ${i} needs exactly one of allow or deny`);
    if (!RULE_TARGET.test(targets[0]!)) throw bad(`rule ${i} must be "METHOD /path"`);
  });
}

/**
 * Change a grant's preset/rules/GraphQL switch. One UPDATE that keeps the state; then
 * `forge.api.policy` to a node that holds the credential (positive ack required). A node that cannot
 * apply it leaves the DB policy in place and returns `policy-pending` (not rolled back: the policy
 * is the operator's intent, and every later deliver frame carries it). The reason records
 * `policy-pending` only when it was empty or already a policy marker; a lifecycle reason
 * (rotation-pending, previous-revoke-pending, rotation-failed, …) is never overwritten — Task 8's
 * reconcile re-sends the policy on reconnect / compares `forge.api.status`. For a minted grant
 * the token's scopes follow the preset only from the next mint (rotate to widen them).
 */
export async function updateGrantPolicy(deps: ForgeApiDeps, input: UpdatePolicyInput): Promise<PolicyResult> {
  checkPolicy(input);
  const stale = await loadGrant(deps.db, toRef(input));
  return withGrantClaim(stale.tenantId, stale.id, async () => {
    const row = await loadGrant(deps.db, stale);
    if (row.state === "revoking" || row.state === "revoked") {
      throw new ForgeApiGrantError("grant-not-deliverable", `forge grant ${row.id} is ${row.state}.`, row.id);
    }
    const ackNow = input.acknowledgeSameUser === true && !row.sameUserAckAt;
    if (isWriteGrant(input) && !row.sameUserAckAt && !ackNow && row.isolation !== "separate-user") {
      throw sameUserRequired(row.stationIdSnapshot, row.id);
    }
    const ackAt = ackNow ? deps.now() : undefined;
    const onNode = (row.state === "delivered" || row.state === "verified") && row.stationId !== null;
    const save = async (reason: string | null | undefined, from: ForgeGrantState[], pendingSince?: Date | null) => {
      const set: Partial<typeof g.$inferInsert> = {
        preset: input.preset,
        rules: input.rules,
        allowGraphql: input.allowGraphql,
        updatedAt: deps.now(),
      };
      if (reason !== undefined) set.stateReason = reason;
      if (ackAt) {
        set.sameUserAckAt = ackAt;
        set.sameUserAckBy = input.actor ?? null;
      }
      // The outstanding-policy flag, independent of the reason: written in the same UPDATE.
      if (pendingSince !== undefined) set.policyPendingSince = pendingSince;
      const [out] = await deps.db
        .update(g)
        .set(set)
        .where(and(eq(g.tenantId, row.tenantId), eq(g.id, row.id), inArray(g.state, from)))
        .returning();
      if (!out) throw new ForgeApiGrantError("state-conflict", `forge grant ${row.id} changed underneath the policy update.`, row.id);
      return out;
    };
    if (!onNode) return { outcome: "stored", grant: await save(undefined, [row.state]) };

    // Only our own marker may be written over; a lifecycle reason is left exactly as it is.
    const mayMark = row.stateReason === null || row.stateReason.startsWith("policy-pending");
    const mark = (r: string | null) => (mayMark ? r : undefined);
    // Flagged before the frame goes out: a crash mid-send leaves it for reconcile to re-send.
    let saved = await save(mark("policy-pending: sending to the node"), [row.state], row.policyPendingSince ?? deps.now());
    const station = await loadStation(deps.db, row.tenantId, row.stationId!);
    const why = await sendPolicy(deps, station, row.id, input);
    saved = await save(mark(why ? `policy-pending: ${why}` : null), [saved.state], why ? saved.policyPendingSince : null);
    if (why) log.warn("forge grant policy not applied on the node", { grantId: row.id, stationId: station.id, reason: why });
    return { outcome: why ? "policy-pending" : "applied", grant: saved };
  });
}

/** `forge.api.policy` to the node, positive ack required: null when applied, else why not. */
async function sendPolicy(
  deps: ForgeApiDeps,
  station: StationRow,
  grantId: string,
  input: UpdatePolicyInput,
): Promise<string | null> {
  const params = VERB_PARAMS["forge.api.policy"].safeParse({
    stationId: station.id,
    grantId,
    preset: input.preset,
    rules: input.rules,
    allowGraphql: input.allowGraphql,
  });
  let why: string | null = null;
  if (!params.success) {
    why = "invalid policy frame; nothing was sent";
  } else {
    let res: BrokerReply | undefined;
    try {
      res = await deps.broker.request(station.nodeId, "forge.api.policy", params.data);
    } catch (err) {
      why = untrusted(scrub(err));
    }
    if (res && !res.ok) why = untrusted(res.error ?? "node error");
    if (res?.ok) {
      const ack = VERB_RESULTS["forge.api.policy"].safeParse(res.data);
      if (!ack.success) why = "unreadable policy reply";
      else if (ack.data.ok !== true) why = `node rejected the policy: ${untrusted(ack.data.error ?? "no reason given")}`;
    }
  }
  return why;
}
