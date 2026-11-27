/**
 * Letting a room's members publish their call membership.
 *
 * A call membership is a state event, and a state event needs `state_default` (50) unless the
 * room's power levels say otherwise — which no person in an agent room has. So the three MatrixRTC
 * types are set to 0: the legacy `org.matrix.msc3401.call.member` the calls use today, and the
 * newer `org.matrix.msc4143.rtc.member` / `.rtc.slot` so a later move needs no second change.
 *
 * Read, merged and written back as the agent (the room's creator, at 100), changing nothing else
 * in the event; a room that already has them is not written. New bridge rooms get this at
 * provisioning; rooms that already exist get it once, from `scripts/superdial-call-power-levels.ts`.
 */

import { CALL_MEMBER_TYPE, RTC_MEMBER_TYPE, RTC_SLOT_TYPE } from "./call-config";
import { pathSegment } from "./call-agent-client";

export const CALL_POWER_EVENTS = [CALL_MEMBER_TYPE, RTC_MEMBER_TYPE, RTC_SLOT_TYPE] as const;

/** `content` with each call type at power 0 in `events`, and whether that changed anything. */
export function withCallPowerLevels(content: Record<string, unknown>): {
  content: Record<string, unknown>;
  changed: boolean;
} {
  const current = content.events;
  const events: Record<string, unknown> =
    current !== null && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  let changed = false;
  for (const type of CALL_POWER_EVENTS) {
    if (events[type] !== 0) {
      events[type] = 0;
      changed = true;
    }
  }
  return { content: { ...content, events }, changed };
}

export type PowerLevelResult = "unchanged" | "updated" | "would-update";

export function createPowerLevelEnsurer(deps: {
  homeserverUrl: string;
  asToken: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const doFetch = deps.fetch ?? fetch;
  return async function ensureCallPowerLevels(
    asUserId: string,
    roomId: string,
    opts: { apply?: boolean } = {},
  ): Promise<PowerLevelResult> {
    const url =
      `${deps.homeserverUrl.replace(/\/+$/, "")}/_matrix/client/v3/rooms/${pathSegment(roomId)}` +
      `/state/m.room.power_levels?user_id=${pathSegment(asUserId)}`;
    const headers = { Authorization: `Bearer ${deps.asToken}`, "Content-Type": "application/json" };
    const read = await doFetch(url, { method: "GET", headers });
    if (!read.ok) throw new Error(`could not read the power levels of ${roomId}: ${read.status}`);
    const current: unknown = await read.json();
    if (current === null || typeof current !== "object") throw new Error(`the power levels of ${roomId} are not an object`);
    const { content, changed } = withCallPowerLevels({ ...current });
    if (!changed) return "unchanged";
    if (opts.apply === false) return "would-update";
    const write = await doFetch(url, { method: "PUT", headers, body: JSON.stringify(content) });
    if (!write.ok) throw new Error(`could not write the power levels of ${roomId}: ${write.status}`);
    return "updated";
  };
}
