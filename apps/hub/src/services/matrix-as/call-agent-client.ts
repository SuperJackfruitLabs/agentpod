/**
 * C6, hub → superdial-agent: join a call, leave it, and hand over a spoken turn's reply.
 *
 * superdial-agent serves these over loopback or the Docker network, never publicly, behind the
 * shared `SUPERDIAL_AGENT_TOKEN`. Each answers "done" or "not done"; none throws, because every
 * caller is on a path (an appservice transaction, a turn ending) that must not fail with it.
 */

import { createLogger } from "../../utils/logger";

const log = createLogger("matrix-calls");

/** `PUT /v1/calls/{room_id}`: join, or stay joined. */
export interface CallJoin {
  agent_user_id: string;
  homeserver_url: string;
  device: { device_id: string; access_token: string };
  voice: string;
  stt_language: string | null;
}

export type CallOutcome = "ok" | "cancelled" | "error";

/** `POST /v1/calls/{room_id}/turns/{turn_id}/reply`. v1 sends one message, `final: true`. */
export interface CallReply {
  seq: number;
  text: string;
  final: boolean;
  outcome: CallOutcome;
}

/**
 * How a reply went: `taken`; `gone`, answered 404 because superdial-agent no longer has that call
 * or turn (a caller who hung up as the turn ended — expected, not a fault, and never retried); or
 * `failed`, any other refusal or no answer.
 */
export type ReplyResult = "taken" | "gone" | "failed";

export interface SuperdialAgentClient {
  joinCall(roomId: string, body: CallJoin): Promise<boolean>;
  leaveCall(roomId: string): Promise<boolean>;
  reply(roomId: string, turnId: string, body: CallReply): Promise<ReplyResult>;
}

/**
 * A room id as one path segment, every reserved character percent-encoded (C6: "Room IDs in URL
 * paths are percent-encoded"). `encodeURIComponent` leaves `!` alone, which every room id starts
 * with; both forms decode the same, and `%21` leaves a strict reader no doubt.
 */
export function pathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `/v1/calls/{room_id}`. */
const call = (roomId: string) => `/v1/calls/${pathSegment(roomId)}`;

export function createSuperdialAgentClient(deps: {
  baseUrl: string;
  token: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}): SuperdialAgentClient {
  const doFetch = deps.fetch ?? fetch;
  const base = deps.baseUrl.replace(/\/+$/, "");

  async function send(what: string, method: string, path: string, body?: unknown): Promise<ReplyResult> {
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${deps.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.ok) return "taken";
      if (res.status === 404 && what === "reply") {
        log.debug("superdial-agent no longer has the call a reply was for", { what, status: res.status });
        return "gone";
      }
      log.warn("superdial-agent refused a call request", { what, status: res.status });
      return "failed";
    } catch (err) {
      log.warn("superdial-agent could not be reached", {
        what,
        error: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    }
  }

  return {
    joinCall: async (roomId, body) => (await send("join", "PUT", call(roomId), body)) === "taken",
    leaveCall: async (roomId) => (await send("leave", "DELETE", call(roomId))) === "taken",
    reply: (roomId, turnId, body) =>
      send("reply", "POST", `${call(roomId)}/turns/${pathSegment(turnId)}/reply`, body),
  };
}
