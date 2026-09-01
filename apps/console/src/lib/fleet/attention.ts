/**
 * Derives the attention lane: the list of things on the fleet that need a
 * human, ranked worst-first. Pure function over one FleetSnapshot's worth of
 * data — no fetching here, so it's cheap to test exhaustively.
 */
import type { FleetAgent, NodeSummary, ProvisionedRuntime } from "@agentpod/contract";
import type { StationRow } from "$lib/api/client";
import type { PrincipalSummary } from "$lib/api/grants";
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
// "permission" is listed here (and in AttentionKind) for a complete
// vocabulary, but that rule is not derived below — see the gap note on it.
// Keeping its slot in the order means a future implementation only has to
// fill in the branch, not renumber its neighbours.
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
  /**
   * Station rows, which carry `principalId` — the occupancy fact FleetAgent
   * does not. Optional so a caller that hasn't been widened still
   * type-checks; it simply gets no `unoccupied` items.
   */
  stations?: StationRow[];
  /**
   * The principal directory, for `suspendedAt`. Admin-only (`GET
   * /api/admin/principals`), so this is legitimately empty for most users —
   * see the suspended branch below for what that costs.
   */
  principals?: PrincipalSummary[];
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  const offlineNodeIds = new Set(
    input.nodes.filter((n) => n.status === "offline").map((n) => n.id),
  );

  // Rule 1: unoccupied — a station nothing can dispatch. Two different
  // causes, one item each, because the remedy differs: assign an agent, or
  // lift a suspension.
  const principalsById = new Map((input.principals ?? []).map((p) => [p.id, p]));
  for (const station of input.stations ?? []) {
    // Offline-node suppression: the node item below already explains every
    // station on it, and two items for one cause is the scattering this lane
    // exists to undo.
    if (offlineNodeIds.has(station.nodeId)) continue;

    let detail: string | null = null;
    if (station.principalId === null) {
      detail = "no agent occupies this station";
    } else {
      // A principal id the directory doesn't know is treated as live, not
      // flagged. `principals` is empty for every non-admin, and reporting
      // the whole fleet as undispatchable because the list was unavailable
      // would be the loudest possible false alarm. Same ruling as
      // /agents' stationStatuses.
      const principal = principalsById.get(station.principalId);
      if (principal?.suspendedAt) detail = "its agent is suspended";
    }
    if (detail === null) continue;

    items.push({
      kind: "unoccupied",
      token: "error",
      what: "Dispatchable by nobody",
      who: station.stationKey,
      detail,
      href: `/nodes/${station.nodeId}/stations/${station.id}`,
    });
  }

  // Rule 2: node-offline. A station on an offline node already reads
  // "unknown" because of its node, so we report the node once here rather
  // than once per station on it.
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
