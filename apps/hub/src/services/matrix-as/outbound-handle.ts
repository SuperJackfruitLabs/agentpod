/**
 * What each session event does to the room: an update (text, reasoning, a tool call), a state
 * change (a turn starting, pausing, ending), a permission request, an error. Events arrive here
 * one at a time, in order — see the chain in `outbound.ts`.
 */

import { PERMISSION_REQUEST_CONTENT_KEY, type AcpEvent } from "@agentpod/contract";
import { inlinePermissionOptions, noteHubEvent, permissionDecisionKey } from "../push";
import { requestedAt } from "../acp";
import { foldToolUpdate, noteUnmappedKind, PERMISSION_REQUEST_TYPE, permissionRequestContent } from "./activity";
import { legacyRequestEvents } from "./legacy-events";
import { PERMISSION_OUTCOME_TYPE, harnessPermission, permissionV2Content, type HarnessPermission } from "./permission-wire";
import { flush, scheduleFlush } from "./outbound-flush";
import { log } from "./outbound-log";
import { mark, reportError, startTyping, stopTyping } from "./outbound-marks";
import { chunkTextOfKind, errorMessage, isRecord, messageChunkText, permissionRequest } from "./outbound-payloads";
import { say } from "./outbound-send";
import { detachEnded, REACTION, SILENT_TURN_NOTICE, type RoomContext } from "./outbound-state";
import { fleet, streamLive, streamThought, streamTool } from "./outbound-streams";
import {
  clearPendingPermission,
  notePendingPermission,
  pendingPermissionFor,
  permissionPrompt,
  type PermissionOption,
} from "./permissions";
import type { SpokenTurn } from "./voice-reply";

/** Handle one session event for its room. */
export async function handleEvent(
  ctx: RoomContext,
  event: AcpEvent,
  noted: { eventId: string; voice: boolean } | undefined
): Promise<void> {
  if (ctx.state.ended) return;
  switch (event.type) {
    case "agent-update":
      return onAgentUpdate(ctx, event);
    case "state":
      return onState(ctx, event, noted);
    case "permission-request":
      return onPermissionRequest(ctx, event);
    case "error":
      return onError(ctx, event);
    case "permission-answer":
      return onPermissionAnswer(ctx, event);
    default:
      // user-prompt is an echo of what already happened in the room, or of a
      // console action. Repeating it would make the agent quote the person it
      // is talking to. (permission-answer only settles the record, above.)
      return;
  }
}

/** Text, reasoning or a tool call — or a kind the room does not forward. */
function onAgentUpdate(ctx: RoomContext, event: AcpEvent): void {
  const { sessionId, roomId, state } = ctx;
  const text = messageChunkText(event.payload);
  if (text !== undefined) {
    if (state.pendingError !== null) {
      // The agent is answering after all: the error was an attempt the
      // harness recovered from, not the turn's outcome. See
      // `pendingError`.
      log.info("an agent error was followed by an answer; not reporting it", {
        sessionId,
        roomId,
        error: errorMessage(state.pendingError),
      });
      state.pendingError = null;
    }
    state.produced = true;
    state.buffer.push(text);
    fleet(ctx, ({ name, mxid, at }) => ({ type: "spoke", roomId, mxid, name, at }));
    void streamLive(ctx, false);
    scheduleFlush(ctx);
    return;
  }

  const thought = chunkTextOfKind(event.payload, "agent_thought_chunk");
  if (thought !== undefined) {
    state.thoughtBuffer.push(thought);
    // Only the phase reaches the card; the thought itself goes to the reader's devices.
    fleet(ctx, ({ name, mxid, at }) => ({ type: "thinking", roomId, mxid, name, at }));
    void streamThought(ctx, false);
    return;
  }

  const tool = foldToolUpdate(state.tools, event.payload);
  if (tool !== null) {
    state.produced = true;
    const total = state.tools.size;
    const completed = [...state.tools.values()].filter(
      (t) => t.status === "completed" || t.status === "failed"
    ).length;
    fleet(ctx, ({ name, mxid, at }) => ({ type: "step", roomId, mxid, name, title: tool.title, completed, total, at }));
    void streamTool(ctx, tool);
    return;
  }

  // Everything this path does not forward is recorded once, so the next
  // capability a harness gains does not vanish here the way `tool_call`
  // did for the whole life of the bridge. See `activity.ts`.
  const kind = isRecord(event.payload) ? event.payload.sessionUpdate : undefined;
  if (typeof kind === "string" && noteUnmappedKind(kind)) {
    log.info("a session update kind reaches Matrix and is not forwarded", {
      sessionId,
      kind,
    });
  }
}

/** A turn starting, pausing or ending. */
async function onState(
  ctx: RoomContext,
  event: AcpEvent,
  noted: { eventId: string; voice: boolean } | undefined
): Promise<void> {
  const { sessionId, roomId, state } = ctx;
  const status = isRecord(event.payload) ? event.payload.status : undefined;

  if (status === "working") {
    await onWorking(ctx, noted);
    return;
  }

  // A question only stands while the agent is waiting on it. A turn
  // that moved on — answered in the console, cancelled, failed — must
  // not leave the room able to "approve" something already decided.
  if (status !== "waiting") clearPendingPermission(roomId);

  // Anything that is not `working` means the agent is not typing —
  // including `waiting`, which is a permission request this room cannot
  // yet answer and could sit there for hours. Enumerating only idle and
  // ended left typing on for exactly that case.
  await flush(ctx);
  await stopTyping(ctx);

  if (status === "idle" || status === "ended") await onTurnEnd(ctx, event);

  if (status === "ended") {
    // A session that ended takes its attachment with it — an
    // unsubscribed listener is the leak `_subscriberCountForTest`
    // exists to catch.
    detachEnded(sessionId, state);
  }
}

async function onWorking(ctx: RoomContext, noted: { eventId: string; voice: boolean } | undefined): Promise<void> {
  const { roomId, state } = ctx;
  // Without this the room looks dead for the ten seconds an agent
  // spends thinking. The trigger is picked up here rather than at
  // attach time, because a room outlives any one turn.
  //
  // Only replaced when there is a new one — `working` after a
  // permission pause is the same turn, still owned by its message.
  // (Taken at fan-out, in the subscriber in `outbound.ts` — see `takeTrigger`.)
  if (noted !== undefined) {
    state.triggerEventId = noted.eventId;
    state.voiceTriggered = noted.voice;
  }
  state.inTurn = true;
  fleet(ctx, ({ name, mxid, at }) => ({ type: "turn-started", roomId, mxid, name, at }));
  await startTyping(ctx);
  await mark(ctx, REACTION.working);
}

/** The turn is over: its outcome, its mark, its voice reply, and its claim on the message cleared. */
async function onTurnEnd(ctx: RoomContext, event: AcpEvent): Promise<void> {
  const { state } = ctx;
  const wasTurn = state.inTurn || state.produced;
  state.inTurn = false;
  // An error nothing came after is the turn's outcome: report it now,
  // as it used to be reported the moment it arrived.
  if (state.pendingError !== null) await reportError(ctx);
  // A turn that said nothing, ran nothing, and reported nothing is
  // not a turn that worked. The hub cannot know *why* — the harness
  // that failed did not say — but it can refuse to call silence
  // success, and it can tell the reader that their question went
  // unanswered rather than leaving them to infer it from a tick.
  //
  // Nothing is said when nobody asked: an unprompted turn (a cron
  // job speaking) has no reader waiting and no message to mark.
  //
  // A session that ends mid-turn usually says why (the node went
  // away, the harness exited), and that beats "its own logs will say".
  // A turn the agent chose to leave silent (OpenClaw's NO_REPLY; the
  // hub marks its idle state `silent`) is done, not failed: no
  // notice, and a ✅ on the message it answered by saying nothing.
  const choseSilence = isRecord(event.payload) && event.payload.silent === true;
  if (wasTurn) noteTurnFinished(ctx, state.reportedError || (!state.produced && !choseSilence));
  state.lastTurnCounts = null;
  if (!state.produced && !state.reportedError && choseSilence) {
    await mark(ctx, REACTION.done);
  } else if (!state.produced && !state.reportedError) {
    await mark(ctx, REACTION.failed);
    if (state.triggerEventId) {
      const reason = isRecord(event.payload) ? event.payload.reason : undefined;
      await say(ctx,
        typeof reason === "string" && reason.trim() !== ""
          ? `This turn ended without a reply — ${reason.trim()}`
          : SILENT_TURN_NOTICE
      );
    }
  } else if (!state.reportedError) {
    await mark(ctx, REACTION.done);
  }
  speakTurn(ctx);
  state.turnText = [];
  state.turnTextEventId = null;
  state.open = null;
  state.voiceTriggered = false;
  state.produced = false;
  state.reportedError = false;
  // The turn is over, and so is its claim on the message that started
  // it. A session that later goes `ended` between turns — a node that
  // dropped, 90 minutes after krishna answered — must not come back
  // and fail a message that was answered.
  state.triggerEventId = null;
}

/** Tell the fleet Live Activity the turn finished, with the record's counts. */
function noteTurnFinished(ctx: RoomContext, errored: boolean): void {
  const { roomId, state } = ctx;
  const counts = state.lastTurnCounts ?? { total: 0, failed: 0 };
  fleet(ctx, ({ name, mxid, at }) => ({
    type: "turn-finished",
    roomId,
    mxid,
    name,
    total: counts.total,
    failed: counts.failed,
    ...(counts.failedAt !== undefined ? { failedAt: counts.failedAt } : {}),
    errored,
    at,
  }));
}

/**
 * The reply, spoken — after the text is in the room, never before
 * it and never instead of it. Not awaited: synthesis takes seconds
 * and the next turn must not wait on it. An error turn is not
 * spoken, but it is handed over marked as one, so the replier logs
 * it with every other reason a turn was not spoken; the replier
 * decides the rest (speak mode, service).
 */
function speakTurn(ctx: RoomContext): void {
  const { sessionId, roomId, agentUser, deps, state } = ctx;
  const spokenText = state.turnText.join("\n\n");
  if (deps.speak && state.turnTextEventId && spokenText.trim() !== "") {
    const turn: SpokenTurn = {
      roomId,
      agentUser,
      sessionId,
      text: spokenText,
      textEventId: state.turnTextEventId,
      voiceTriggered: state.voiceTriggered,
      ...(state.reportedError ? { errorTurn: true } : {}),
    };
    void deps.speak(turn).catch((err) => {
      log.warn("the voice replier failed", {
        sessionId,
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

/** A question for the person in the room, answerable by its number. */
async function onPermissionRequest(ctx: RoomContext, event: AcpEvent): Promise<void> {
  const { sessionId, roomId } = ctx;
  const request = permissionRequest(event.payload);
  if (!request) return;

  // Remembered BEFORE the message is sent: an answer cannot arrive
  // before the question, but a reply racing a slow homeserver would
  // find nothing pending and be treated as an ordinary prompt.
  //
  // `event.seq` is the request's own sequence number, which is how
  // `answerPermission` addresses it — the same address the console's
  // WebSocket sends.
  if (request.options.length > 0) {
    notePendingPermission(roomId, {
      sessionId,
      requestSeq: event.seq,
      options: request.options,
    });
  }

  // One event for one question. The structured request rides INSIDE
  // the prose message, under `dev.agentpod.permission`, the way the
  // turn error card rides on its notice — so the one push this message
  // raises is a push the phone can classify, in an encrypted room or
  // not. The prose is what keeps Element and reply-by-number working;
  // the key only lets a client that understands it render buttons.
  // Every answer comes back as an ordinary message through the same
  // matcher, keyed on the pending request above rather than on any
  // event id, so nothing downstream has to know which one a reader used.
  const structured = permissionRequestContent(
    sessionId,
    event.seq,
    request.title,
    request.options
  );
  // permission.v2 (charter: strict decisions and harness permissions bind their subject §5): the
  // same prose message also carries AgentPod's own envelope — meanings, scopes and the
  // `harness-permission/v1` subject — recorded first so an answer is judged against it.
  const v2 = structured ? harnessPermission(sessionId, event.seq, event.payload, requestedAt(event.createdAt)) : null;
  if (v2) await recordPermission(ctx, v2);
  const proseId = await say(ctx,
    permissionPrompt(request.title, request.options),
    structured ? { ...(v2 ? permissionV2Content(v2) : {}), [PERMISSION_REQUEST_CONTENT_KEY]: structured } : undefined
  );
  noteHubEvent(proseId, "permission");
  if (v2 && proseId) await notePermissionEvent(ctx, v2.requestId, proseId);

  if (proseId && request.options.length > 0) noteDecisionAsked(ctx, event.seq, proseId, request);

  // …and, while clients in the field still read only it, the same
  // payload again as its own event. Gated on the legacy flag
  // (`AGENTPOD_LEGACY_PERMISSION_EVENTS`, default on).
  if (structured && ctx.deps.client.sendCustomEvent && legacyRequestEvents()) {
    await sendLegacyRequest(ctx, structured, proseId);
  }
}

/** Record the binding; a failure is logged, never a lost question — the room still asks. */
async function recordPermission(ctx: RoomContext, p: HarnessPermission): Promise<void> {
  try {
    await ctx.deps.permissionRecords?.record(ctx.roomId, p);
  } catch (err) {
    log.error("could not record a permission request; answers fall back to the room's memory", {
      sessionId: ctx.sessionId,
      requestId: p.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function notePermissionEvent(ctx: RoomContext, requestId: string, eventId: string): Promise<void> {
  try {
    await ctx.deps.permissionRecords?.noteEvent(requestId, eventId);
  } catch (err) {
    log.error("could not note a permission request's message", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The fleet Live Activity's decision — only while the question still
 * stands: an answer that raced this send must not leave it showing.
 */
function noteDecisionAsked(
  ctx: RoomContext,
  eventSeq: number,
  proseId: string,
  request: { title: string; options: PermissionOption[] }
): void {
  const { roomId } = ctx;
  fleet(ctx, ({ name, at }) =>
    pendingPermissionFor(roomId)?.requestSeq === eventSeq
      ? {
          type: "decision-asked",
          decision: {
            key: permissionDecisionKey(roomId),
            roomId,
            eventId: proseId,
            agent: name,
            kind: "permission",
            question: request.title,
            options: inlinePermissionOptions(request.options),
            askedAt: at,
          },
        }
      : null
  );
}

/** The same request again as its own event, for clients that read only that (the legacy flag is on). */
async function sendLegacyRequest(
  ctx: RoomContext,
  structured: Record<string, unknown>,
  proseId: string | null
): Promise<void> {
  const { sessionId, roomId, agentUser, deps } = ctx;
  if (!deps.client.sendCustomEvent) return;
  const legacyId = await deps.client
    .sendCustomEvent(agentUser, roomId, PERMISSION_REQUEST_TYPE, structured)
    .catch((err) => {
      log.error("could not send a structured permission request", {
        sessionId,
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
  // The prose already pushed; this one must not buzz a second time.
  // Only when the prose landed — otherwise this is the question.
  if (proseId) noteHubEvent(legacyId, "companion");
}

/**
 * A permission answered anywhere — the console, a board, an editor, or released as the session
 * ended. The room's record and card are closed with the real outcome, so a request answered in the
 * console is never swept as expired. Not repeated in words otherwise: the person answered.
 */
async function onPermissionAnswer(ctx: RoomContext, event: AcpEvent): Promise<void> {
  const { agentUser, roomId, deps } = ctx;
  const records = deps.permissionRecords;
  if (!records?.settle) return;
  try {
    await records.settle(ctx.sessionId, event.payload, {
      say: (body) => say(ctx, body),
      sendOutcome: async (content) =>
        deps.client.sendCustomEvent ? deps.client.sendCustomEvent(agentUser, roomId, PERMISSION_OUTCOME_TYPE, content) : null,
    });
  } catch (err) {
    log.error("could not settle a permission request's record", {
      sessionId: ctx.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function onError(ctx: RoomContext, event: AcpEvent): Promise<void> {
  const { state } = ctx;
  // Held, not posted: the harness may be about to retry on a fallback
  // model. Reported at turn end if nothing follows — see
  // `pendingError`. The latest one wins: when every attempt fails, the
  // last error is the one that describes the whole chain.
  state.pendingError = event.payload ?? {};
  // Outside a turn there is no end to wait for: said now, as before.
  if (!state.inTurn) await reportError(ctx);
}
