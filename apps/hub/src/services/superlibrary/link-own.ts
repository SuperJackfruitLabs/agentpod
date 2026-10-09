/**
 * Link from the caller's OWN station: the glue between the MCP tool and `linkArtifact`.
 *
 * The station, its tenant and its node state come only from the hub's own records for the calling
 * principal. The tool input carries a path and nothing that names a station, and the actor is the
 * calling agent (R-H1: the hub never acts for a person).
 */
import type { SelfStation } from "../self-station";
import type { LinkInput, LinkResult } from "./link";

export interface OwnLinkDeps {
  stationFor(principalId: string): Promise<SelfStation | null>;
  link(input: LinkInput): Promise<LinkResult>;
}

export async function linkFromOwnStation(
  deps: OwnLinkDeps,
  input: Omit<LinkInput, "station" | "actor"> & { principalId: string },
): Promise<LinkResult> {
  const station = await deps.stationFor(input.principalId);
  if (!station) return { ok: false, status: 403, error: "no_station", message: "You are not currently placed in a station." };
  const { principalId, ...rest } = input;
  return deps.link({
    ...rest,
    station: {
      id: station.id,
      stationKey: station.stationKey,
      nodeId: station.nodeId,
      // An unknown node state is not online.
      nodeStatus: station.nodeStatus ?? "offline",
      tenantId: station.tenantId,
      // Node-level (hello frame). Null stays null: a node that never said is not refused here.
      capabilities: station.nodeCapabilities,
    },
    actor: { principal: principalId, kind: "agent" },
  });
}
