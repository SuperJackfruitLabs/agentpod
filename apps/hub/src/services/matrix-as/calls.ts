/**
 * The hub's half of a superdial call, assembled.
 *
 *   person's call.member ──▶ watcher ──▶ PUT /v1/calls/{room}   (with the agent's call device)
 *   last person leaves   ──▶ watcher ──▶ DELETE /v1/calls/{room}
 *   superdial-agent's cancel ──▶ the turn's session ──▶ cancelTurn
 *
 * Built only when calls are on (`superdialConfig().enabled`); with them off the bridge holds
 * `null` and nothing here runs. Everything that reaches the homeserver or the database is
 * injected, so the rules are tested without either.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import { matrixRooms } from "../../db/schema/matrix";
import { createLogger } from "../../utils/logger";
import { cancelTurn } from "../acp";
import { speechSettings } from "../speech";
import { DEFAULT_CALL_VOICE, superdialConfig, type SuperdialConfig } from "./call-config";
import { createSuperdialAgentClient, type SuperdialAgentClient } from "./call-agent-client";
import { createCallDeviceProvisioner, type CallDevice } from "./call-device";
import { callRoomFor, createCallWatcher, type CallMemberEvent, type CallRoom } from "./call-members";
import { callTurnOutcome, callTurnsCancelled, callTurnSession, forgetCallTurns, markCallTurnCancelled } from "./call-turns";
import { liveCallTurns as outboundLiveCallTurns, type CallTurnReply } from "./outbound-state";
import { checkCallMembership, createMembershipReader, type MembershipAnswer } from "./call-membership";

const log = createLogger("matrix-calls");

export interface CallsDeps {
  config: SuperdialConfig;
  domain: string;
  /** Handed to superdial-agent: where the call device talks to the homeserver. */
  homeserverUrl: string;
  agent: SuperdialAgentClient;
  callDeviceFor(agentUserId: string): Promise<CallDevice>;
  /** The station's voice, as its speech settings resolve it. */
  voiceFor(stationId: string): Promise<string>;
  /** Defaults to `callRoomFor`. */
  roomFor?: (roomId: string) => Promise<CallRoom | null>;
  /** A session's owner and room. Defaults to a read of `acp_sessions` and `matrix_rooms`. */
  sessionFor?: (sessionId: string) => Promise<{ userId: string; roomId: string } | null>;
  /** `cancelTurn` from the ACP module: `session/cancel`, or a Salaam cancellation intent. */
  cancel(userId: string, sessionId: string): Promise<void>;
  /** A person's membership of a room, read live from the homeserver as `asUser` (C4). */
  membershipOf(asUser: string, roomId: string, userId: string): Promise<string | null>;
  /**
   * The spoken turns a session's prompt answers now. Defaults to the room outbound path's record
   * (`liveCallTurns`).
   */
  liveCallTurns?: (sessionId: string) => readonly string[];
}

export interface Calls {
  config: SuperdialConfig;
  /**
   * An `org.matrix.msc3401.call.member` event from a transaction. Queued behind the room's earlier
   * call memberships and NOT waited for: the join or leave it causes talks to superdial-agent and
   * may mint a device, and the appservice transaction carrying it holds every later one while its
   * handler runs. Resolves once queued; never rejects.
   */
  onCallMember(event: CallMemberEvent): Promise<void>;
  /** Every call membership queued so far has been handled (its join or leave ran or gave up). */
  settled(): Promise<void>;
  /** C6 `POST /internal/superdial/turns/{turn_id}/cancel`. Never throws for an unknown turn. */
  cancelTurn(turnId: string, roomId: string): Promise<void>;
  /**
   * Did the caller cancel any of these turns? Such a turn ends silently: no notice in the room,
   * and no reply to a call that is gone.
   */
  cancelledByCaller(roomId: string, turnIds: readonly string[]): boolean;
  /**
   * A spoken turn ended: its reply to the call (C6 reply, `seq: 0`, `final: true`). Several turn
   * ids when queued turns were merged into one prompt: the last gets the answer, each earlier one
   * is closed `cancelled` with no text, so one answer is spoken once and nobody waits for ever.
   * Nothing is sent for turns the caller cancelled: superdial-agent left that call.
   */
  replyToCall(reply: CallTurnReply): Promise<void>;
  /** Spoken turns whose prompt never reached the agent: each closed `error`, with no text. */
  replyUnanswered(roomId: string, turnIds: string[]): Promise<void>;
  /** C4: may this person have a LiveKit token for this room? Throws when it cannot be told. */
  membership(input: { userId: string; roomId: string }): Promise<MembershipAnswer>;
}

/** The owner of a session and the room it answers in, or null. */
async function sessionRow(sessionId: string): Promise<{ userId: string; roomId: string } | null> {
  const [row] = await db
    .select({ userId: acpSessions.userId, roomId: matrixRooms.roomId })
    .from(acpSessions)
    .innerJoin(matrixRooms, eq(matrixRooms.acpSessionId, acpSessions.id))
    .where(eq(acpSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

export function createCalls(deps: CallsDeps): Calls {
  const roomFor = deps.roomFor ?? ((roomId: string) => callRoomFor(roomId, deps.domain));
  const sessionFor = deps.sessionFor ?? sessionRow;
  const liveCallTurns = deps.liveCallTurns ?? outboundLiveCallTurns;

  async function voiceFor(stationId: string): Promise<string> {
    try {
      return (await deps.voiceFor(stationId)) || DEFAULT_CALL_VOICE;
    } catch (err) {
      log.warn("a station's voice could not be read; the call speaks in the default voice", {
        stationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return DEFAULT_CALL_VOICE;
    }
  }

  const watcher = createCallWatcher({
    domain: deps.domain,
    roomFor,
    async onJoin(room) {
      const agentUserId = room.agentUserId;
      if (!agentUserId) return;
      let device: CallDevice;
      try {
        device = await deps.callDeviceFor(agentUserId);
      } catch (err) {
        log.error("the agent has no call device; the call is not joined", {
          roomId: room.roomId,
          agent: agentUserId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const joined = await deps.agent.joinCall(room.roomId, {
        agent_user_id: agentUserId,
        homeserver_url: deps.homeserverUrl,
        device: { device_id: device.deviceId, access_token: device.accessToken },
        voice: await voiceFor(room.stationId),
        // Transcription settings carry no language today; superdial-agent detects it.
        stt_language: null,
      });
      if (!joined) log.warn("superdial-agent did not join the call", { roomId: room.roomId, agent: agentUserId });
    },
    async onLeave(roomId) {
      await deps.agent.leaveCall(roomId);
    },
  });

  /**
   * Per room, the call memberships still being handled, in order: a leave must not reach
   * superdial-agent before the join it ends.
   */
  const queues = new Map<string, Promise<void>>();
  function enqueue(event: CallMemberEvent): void {
    const key = event.room_id ?? "";
    const next = (queues.get(key) ?? Promise.resolve())
      .then(() => watcher.handle(event))
      .catch((err: unknown) =>
        log.error("a call membership could not be handled", {
          roomId: event.room_id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    queues.set(key, next);
    void next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  }

  async function close(roomId: string, turnId: string, text: string, outcome: "ok" | "cancelled" | "error") {
    const sent = await deps.agent.reply(roomId, turnId, { seq: 0, text, final: true, outcome });
    // `gone` is a call that ended first; the client said so at debug.
    if (sent === "failed") log.warn("superdial-agent did not take a spoken turn's reply", { roomId, turnId, outcome });
  }

  return {
    config: deps.config,
    onCallMember: async (event) => enqueue(event),
    async settled() {
      while (queues.size > 0) await Promise.all(queues.values());
    },
    cancelledByCaller: (roomId, turnIds) => callTurnsCancelled(roomId, turnIds),

    async replyToCall({ roomId, turnIds, text, errored }) {
      const last = turnIds.at(-1);
      if (last === undefined) return;
      if (callTurnsCancelled(roomId, turnIds)) {
        // The caller hung up and superdial-agent cancelled the turn as it left: nobody to answer.
        forgetCallTurns(roomId, turnIds);
        return;
      }
      const outcome = callTurnOutcome(roomId, last, errored);
      // Forgotten before the replies go out: the room's next prompt may run while they do.
      forgetCallTurns(roomId, turnIds);
      for (const turnId of turnIds.slice(0, -1)) await close(roomId, turnId, "", "cancelled");
      await close(roomId, last, text, outcome);
    },

    membership: (input) =>
      checkCallMembership(input, {
        enabled: deps.config.enabled,
        roomFor,
        membershipOf: (asUser, roomId, userId) => deps.membershipOf(asUser, roomId, userId),
      }),

    async replyUnanswered(roomId, turnIds) {
      forgetCallTurns(roomId, turnIds);
      for (const turnId of turnIds) await close(roomId, turnId, "", "error");
    },

    async cancelTurn(turnId, roomId) {
      // Looked up in the room the cancel names: a turn id is only its own room's.
      const sessionId = callTurnSession(roomId, turnId);
      if (!sessionId) {
        log.info("a cancel for a spoken turn the hub is not running", { turnId, roomId });
        return;
      }
      const session = await sessionFor(sessionId);
      // The turn must be the one the caller says it is: a cancel names its room, and a room is
      // what superdial-agent was asked to join. A mismatch stops nothing.
      if (!session || session.roomId !== roomId) {
        log.warn("a cancel named a room its turn is not in; nothing was stopped", { turnId, roomId });
        return;
      }
      // A cancel stops whatever the session is running now. A turn that ended (its reply to the call
      // may still be on its way) or never started (it lost the busy race) is not that, and the
      // room's next turn, typed or spoken, is not the caller's to stop.
      if (!liveCallTurns(sessionId).includes(turnId)) {
        log.info("a cancel for a spoken turn that is no longer running; nothing was stopped", {
          turnId,
          roomId,
          sessionId,
        });
        return;
      }
      markCallTurnCancelled(roomId, turnId);
      try {
        await deps.cancel(session.userId, sessionId);
        log.info("cancelled a spoken turn at the caller's hang-up", { turnId, roomId, sessionId });
      } catch (err) {
        // A turn that already ended, or a session gone, is not a failure of the cancel.
        log.warn("could not cancel a spoken turn", {
          turnId,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/**
 * The calls a bridge runs, or null when calls are off. What `service.ts` builds: superdial-agent
 * at `SUPERDIAL_AGENT_URL`, call devices minted with the appservice token (which never leaves
 * the hub), the voice each station's speech settings give it, and ACP's own `cancelTurn`.
 */
export function callsForBridge(
  bridge: { domain: string; homeserverUrl: string; asToken: string },
  config: SuperdialConfig = superdialConfig(),
): Calls | null {
  if (!config.enabled) return null;
  log.info("superdial calls are on", { agentUrl: config.agentUrl });
  return createCalls({
    config,
    domain: bridge.domain,
    homeserverUrl: bridge.homeserverUrl,
    agent: createSuperdialAgentClient({ baseUrl: config.agentUrl, token: config.agentToken }),
    callDeviceFor: createCallDeviceProvisioner({ homeserverUrl: bridge.homeserverUrl, asToken: bridge.asToken }),
    voiceFor: async (stationId) => (await speechSettings.getStationView(stationId)).effective.voice,
    cancel: (userId, sessionId) => cancelTurn(userId, sessionId),
    membershipOf: createMembershipReader({ homeserverUrl: bridge.homeserverUrl, asToken: bridge.asToken }),
  });
}
