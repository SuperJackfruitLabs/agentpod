/**
 * rollout — updating the fleet from the hub, in an order an operator can read.
 *
 * Issue #295: nothing ever asked a node to update. Self-update worked and was
 * never invoked — no ticker in the agent, no scheduler in the hub, no check on
 * connect — so the fleet stayed on whatever version it was installed with while
 * the docs read as if updates were automatic.
 *
 * This is the hub-driven answer rather than an agent-side timer. The hub
 * already knows every node's version and the latest tag, so it can go in a
 * deliberate order; an unattended binary swap plus service restart on nodes
 * running live agent sessions is the version of this feature most likely to
 * bite at the worst possible moment.
 *
 * Split into a pure planner and an executor on purpose. Which node gets touched
 * and why one did not is the part an operator has to trust, and it should be
 * arguable without a database, a network, or a fleet.
 */

/** What the planner needs to know about a node. A subset of NodeSummary. */
export interface RolloutNode {
  id: string;
  name: string;
  status: string;
  agentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  /**
   * True when this node's binary comes from an image rather than from disk —
   * the driver declares `imageBinding: "fixed"` (#349).
   *
   * Such a node cannot be moved forward by self-update **by construction**:
   * the swap does not survive a restart from the image, and the exit that
   * self-update performs to hand over to a supervisor is, on a container
   * substrate with no supervisor, simply the station stopping.
   */
  imageFixed?: boolean;
}

export interface PlanItem {
  nodeId: string;
  name: string;
  action: "update" | "skip";
  /** Why it is being skipped. Present only for `skip`. */
  reason?: string;
}

export interface PlanOptions {
  /**
   * Update nodes that are already current. Does NOT override "offline" or
   * "no latest release" — neither is a policy choice, they are absences of a
   * thing the update needs.
   */
  force?: boolean;
  /** Restrict the rollout to these node ids. */
  only?: string[];
}

/**
 * Decide what the rollout will do to each node, and why.
 *
 * Ordered by name so two runs over the same fleet read the same way, and so an
 * operator watching can tell where it has got to.
 */
export function planRollout(nodes: RolloutNode[], opts: PlanOptions): PlanItem[] {
  const only = opts.only ? new Set(opts.only) : null;

  return nodes
    .filter((n) => (only ? only.has(n.id) : true))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((n): PlanItem => {
      const skip = (reason: string): PlanItem => ({
        nodeId: n.id,
        name: n.name,
        action: "skip",
        reason,
      });

      // No target. Updating a fleet towards an unknown version is worse than
      // doing nothing, and `force` cannot conjure a release that GitHub did not
      // answer with.
      if (n.latestVersion == null) {
        return skip("the latest release could not be resolved");
      }

      // Not a policy choice: a node that is not connected cannot be sent an
      // RPC. Calling this a failure would make every rollout report failures
      // for machines that are merely switched off.
      if (n.status !== "online") return skip(`the node is ${n.status || "offline"}`);

      // Also not a policy choice, and checked BEFORE force for that reason:
      // sending this node an update does not update it, it stops it. The
      // binary is swapped into an ephemeral disk and the process exits looking
      // for a supervisor that a container does not have.
      if (n.imageFixed) {
        return skip(
          "its binary comes from the substrate's image — update it by bumping " +
            "AGENTPOD_VERSION in that image, redeploying, and restarting the runtime"
        );
      }

      if (opts.force) return { nodeId: n.id, name: n.name, action: "update" };

      if (n.agentVersion == null) {
        return skip("the node's version is unknown; use force to update anyway");
      }

      if (!n.updateAvailable) return skip(`already current (${n.agentVersion})`);

      return { nodeId: n.id, name: n.name, action: "update" };
    });
}

/** What a node answers inside the broker envelope's `data` for "update". */
interface UpdateResult {
  ok?: boolean;
  updating?: boolean;
  tag?: string;
  currentVersion?: string;
  reason?: string;
  error?: string;
}

type BrokerResponse = { ok: boolean; data?: unknown; error?: string };
export type RequestFn = (
  nodeId: string,
  verb: string,
  payload: unknown
) => Promise<BrokerResponse>;

export interface RolloutResult {
  nodeId: string;
  name: string;
  /**
   * - `updated` — the node accepted and began the swap
   * - `no-op`   — the node answered but had nothing to do
   * - `skipped` — never attempted; see `reason`
   * - `failed`  — attempted and did not happen; see `error`
   */
  outcome: "updated" | "no-op" | "skipped" | "failed";
  tag?: string;
  reason?: string;
  error?: string;
}

export interface ExecuteOptions {
  request: RequestFn;
  force?: boolean;
  /** Called as each node resolves, for progress logging. */
  onResult?: (result: RolloutResult) => void;
}

/**
 * Run the plan, one node at a time.
 *
 * Sequential deliberately. Restarting every node at once is how an update
 * becomes an outage, and the whole reason to drive this from the hub rather
 * than from a timer on each host is that the hub can take them in turn.
 *
 * One node failing never stops the rollout or throws: the caller gets a row per
 * node, because "which ones worked" is the only useful answer here.
 */
export async function executeRollout(
  plan: PlanItem[],
  opts: ExecuteOptions
): Promise<RolloutResult[]> {
  const results: RolloutResult[] = [];

  for (const item of plan) {
    const result = await runOne(item, opts);
    results.push(result);
    opts.onResult?.(result);
  }

  return results;
}

async function runOne(item: PlanItem, opts: ExecuteOptions): Promise<RolloutResult> {
  const base = { nodeId: item.nodeId, name: item.name };

  if (item.action === "skip") {
    return { ...base, outcome: "skipped", reason: item.reason };
  }

  let response: BrokerResponse;
  try {
    response = await opts.request(item.nodeId, "update", { force: opts.force ?? false });
  } catch (error) {
    // A throw here is one node's socket, not the rollout's problem.
    return {
      ...base,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // The RPC never reached the node, or the node rejected the frame.
  if (!response.ok) {
    return { ...base, outcome: "failed", error: response.error ?? "update failed" };
  }

  // The round-trip succeeded but the update did not — a 404 on the release, a
  // checksum that did not match. Reporting that as success is the same lie the
  // single-node route refuses to tell: the node is still on the old binary.
  const data = (response.data ?? {}) as UpdateResult;
  if (data.ok === false) {
    return { ...base, outcome: "failed", error: data.error ?? "update failed" };
  }

  if (data.updating === false) {
    return { ...base, outcome: "no-op", reason: data.reason, tag: data.tag };
  }

  return { ...base, outcome: "updated", tag: data.tag };
}

/** A one-line summary for logs and the API response. */
export function summarise(results: RolloutResult[]): Record<string, number> {
  const counts: Record<string, number> = { updated: 0, "no-op": 0, skipped: 0, failed: 0 };
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  return counts;
}
