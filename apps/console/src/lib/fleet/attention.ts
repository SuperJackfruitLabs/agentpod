/**
 * Derives the attention lane: the list of things on the fleet that need a
 * human, ranked worst-first. Pure function over one FleetSnapshot's worth of
 * data — no fetching here, so it's cheap to test exhaustively.
 */
import type { FleetAgent, NodeSummary, ProvisionedRuntime } from "@agentpod/contract";
import type { StateId } from "./state";

export type AttentionKind = "permission" | "unoccupied" | "node-offline" | "drift" | "runtime-error";

export interface AttentionItem {
  kind: AttentionKind;
  /** The state token that colours the tick. */
  token: StateId;
  /** Prose. Sentence case, no trailing period. "Waiting on your answer" */
  what: string;
  /** The machine-issued name of the thing. Rendered in mono. */
  who: string;
  /** Prose detail. "wants to run a shell command" */
  detail: string;
  /** Where clicking goes. */
  href: string;
}

// Rule priority, worst first — matches the numbered rules in the task brief.
// "unoccupied" and "permission" are listed here (and in AttentionKind) for a
// complete vocabulary, but neither rule is derived below — see the gap notes
// on each. Keeping their slots in the order means a future implementation
// only has to fill in the branch, not renumber its neighbours.
const KIND_PRIORITY: Record<AttentionKind, number> = {
  unoccupied: 0,
  "node-offline": 1,
  "runtime-error": 2,
  drift: 3,
  permission: 4,
};

export function deriveAttention(input: {
  agents: FleetAgent[];
  nodes: NodeSummary[];
  runtimes: ProvisionedRuntime[];
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  // Rule 1, "unoccupied", is UNDERIVED: it needs a principal/occupant field
  // on the station row (or a suspended flag on that principal), and
  // FleetAgent (GET /api/fleet/agents) carries neither — see task report.

  // Rule 2: node-offline. A station on an offline node already reads
  // "unknown" because of its node, so we report the node once here rather
  // than once per station on it (the offline-node suppression the brief
  // calls out — there is currently no per-station rule that would otherwise
  // duplicate this, since rule 1 is underiveable, but the count below still
  // reflects every station on the node, not a re-derivation per station).
  for (const node of input.nodes) {
    if (node.status !== "offline") continue;
    const stationCount = input.agents.filter((a) => a.nodeId === node.id).length;
    items.push({
      kind: "node-offline",
      token: "error",
      what: "Node offline",
      who: node.name,
      detail: `${stationCount} agent${stationCount === 1 ? "" : "s"} unknown`,
      href: `/nodes/${node.id}`,
    });
  }

  // Rule 3: runtime-error.
  for (const runtime of input.runtimes) {
    if (runtime.status !== "error") continue;
    items.push({
      kind: "runtime-error",
      token: "error",
      what: "Runtime failed to start",
      who: runtime.name,
      detail: runtime.statusReason ?? "no reason given",
      href: "/runtimes",
    });
  }

  // Rule 4: drift. updateAvailable is only ever true when both version
  // fields are non-null and differ (contract guarantee — see
  // NodeSummary.updateAvailable), so the "unknown" fallbacks below are
  // defensive rather than expected to fire.
  for (const node of input.nodes) {
    if (!node.updateAvailable) continue;
    items.push({
      kind: "drift",
      token: "unknown",
      what: "Node agent is behind",
      who: node.name,
      detail: `${node.agentVersion ?? "unknown"} to ${node.latestVersion ?? "unknown"}`,
      href: `/nodes/${node.id}`,
    });
  }

  // Rule 5, "permission", is UNDERIVED: the fleet endpoint does not report a
  // waiting ACP session. No endpoint exists to derive it from — see task
  // report. Kept in AttentionKind so callers can already switch on it.

  return items.sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
}
