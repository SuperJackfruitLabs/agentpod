/**
 * Whether a session may be opened on a station: the readiness gates, the one-execution refusal
 * for a Salaam station, decision 3's interactive workspace admin, and the node's capabilities.
 */

import { eq } from "drizzle-orm";
import type { StationBusyHolder } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { nodes } from "../../db/schema/nodes";
import { connectionManager } from "../broker";
import { salaamStationHolder, type SalaamStationHolder } from "../salaam";
import { gateCapability, getStation } from "../stations";
import { displayName } from "./rows";
import type { CreateSessionInput } from "./session-state";

/** Whether a session could be opened here right now, and if not, why not. */
export interface StationReadiness {
  ready: boolean;
  /** The sentence `createSession` would have thrown. Absent when ready. */
  reason?: string;
  /** A Salaam station's one live execution, when that is what refused. */
  holder?: SalaamStationHolder;
}

/** The generic refusal sentence, for readers that cannot say who (the bridge's readiness). */
export const STATION_BUSY_REASON =
  "Another session holds this agent's one live execution; it takes one at a time.";

/**
 * A Salaam station already runs someone's execution (one at a time: an agent must never act on
 * two people's authority at once). Carries who, and since when, so the refusal can say so.
 */
export class SalaamStationBusy extends Error {
  override name = "SalaamStationBusy";
  readonly code = "station_busy";
  constructor(readonly holder: StationBusyHolder) {
    const who = holder.you ? "You are" : `${holder.name} is`;
    super(
      holder.state === "stopping"
        ? `${holder.you ? "Your" : `${holder.name}'s`} last session with this agent is still stopping (since ${holder.since}). It takes one at a time.`
        : `${who} in a session with this agent since ${holder.since}. It takes one at a time.`,
    );
  }
}

export function isSalaamStationBusy(e: unknown): e is SalaamStationBusy {
  return e instanceof SalaamStationBusy || (e as { name?: string })?.name === "SalaamStationBusy";
}

export async function busyRefusal(holder: SalaamStationHolder, callerId: string): Promise<SalaamStationBusy> {
  const you = holder.userId === callerId;
  return new SalaamStationBusy({
    name: you ? "You" : await displayName(holder.userId),
    you,
    since: holder.since.toISOString(),
    state: holder.state,
    ...(you ? { sessionId: holder.sessionId } : {}),
  });
}

/**
 * Can a session be opened on this station at all?
 *
 * The same three gates `createSession` fails fast on, asked without opening
 * anything — for callers that want to know *before* they take on an obligation
 * they would then have to unwind. The superpipeline bridge is the first: it claims a
 * card from a board and a claim it cannot execute strands that card until the
 * board's 15-minute reclaim, so it asks here first.
 *
 * Deliberately no stricter than the open it stands in front of. A probe that
 * refused a station `createSession` would have accepted turns every start into
 * an outage with no error anywhere — the caller simply never acts.
 */
export async function stationReadiness(
  scope: { tenantId: string },
  stationId: string,
): Promise<StationReadiness> {
  const station = await getStation(scope, stationId);
  if (!station) return { ready: false, reason: "Station not found." };
  if (!gateCapability(station, "acp")) {
    return {
      ready: false,
      reason: "This station does not support agent sessions.",
    };
  }
  if (!connectionManager.isOnline(station.nodeId)) {
    return { ready: false, reason: "Node is offline." };
  }
  if (station.harness === "salaam") {
    const holder = await salaamStationHolder(station.id);
    if (holder) return { ready: false, reason: STATION_BUSY_REASON, holder };
  }
  return { ready: true };
}

/**
 * Decision 3 (spec 2026-10-23): a workspace owner or admin chatting with the workspace's agent
 * from the console needs no separate mayDispatch grant. Interactive only: a bridge run (any
 * `executionRun`) never qualifies, whatever role is passed.
 */
export function interactiveWorkspaceAdmin(input: Pick<CreateSessionInput, "workspaceRole" | "executionRun">): boolean {
  return input.executionRun === undefined && (input.workspaceRole === "owner" || input.workspaceRole === "admin");
}

/**
 * Whether a node reads hub frames large enough for an image — it advertised
 * "frames.large" in its last hello. Read at prompt time, not cached: a node
 * that updates mid-session should get images from its next turn.
 */
export async function nodeReadsLargeFrames(nodeId: string): Promise<boolean> {
  return nodeHasCapability(nodeId, "frames.large");
}

/** Whether a node advertised a capability in its last hello. */
export async function nodeHasCapability(
  nodeId: string,
  capability: string,
): Promise<boolean> {
  const rows = await db
    .select({ capabilities: nodes.capabilities })
    .from(nodes)
    .where(eq(nodes.id, nodeId));
  const caps = rows[0]?.capabilities;
  return Array.isArray(caps) && caps.includes(capability);
}
