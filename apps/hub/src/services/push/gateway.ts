/**
 * The Matrix push gateway: a homeserver's notify in, one APNs push per device out.
 *
 * Operator decision 2026-09-28: the gateway lives in the hub rather than in
 * Sygnal. The pusher supermessage registers is `format: "event_id_only"`, so
 * what arrives is an event id, a room id and an unread count — and that, plus
 * a category when the hub itself asked the question, and a finished turn's
 * tool counts on the answer that ended it, is all that leaves. The app's
 * Notification Service Extension fetches and decrypts the event.
 *
 * **Not the whole of what the hub sends Apple any more.** The fleet Live
 * Activity (`fleet/`, operator decision 2026-09-29) pushes agent names, step
 * titles and decision questions and options in PLAINTEXT, over its own
 * `liveactivity` push type. That is a deliberate trade the operator accepted
 * for a Lock Screen that stays live with the app closed; it does not loosen
 * this file. A message push still carries ids only.
 *
 * Spec: https://spec.matrix.org/latest/push-gateway-api/
 */

import { z } from "zod";
import {
  ApnsPushPayload,
  PUSH_ALERT_BODY,
  PUSH_ALERT_TITLE,
  type PushCategory,
} from "@agentpod/contract";

import { createLogger } from "../../utils/logger";
import type { ApnsClient } from "./apns";
import type { ApnsEnvironment } from "./config";
import {
  hubEventKind,
  hubEventTurn,
  quietSendsInFlight,
  quietSendsSettled,
  type HubEventKind,
  type TurnCounts,
} from "./hub-events";

const log = createLogger("push-gateway");

// ─── The request ─────────────────────────────────────────────────────────────

/**
 * What the homeserver POSTs. Unauthenticated by the spec, so strict about
 * everything this reads and bounded everywhere. The optional content-bearing
 * fields a `full`-format pusher would send are accepted as the spec types them
 * and then never read.
 */
export const NotifyDevice = z.object({
  app_id: z.string().min(1).max(64),
  pushkey: z.string().min(1).max(512),
  pushkey_ts: z.number().int().nonnegative().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  tweaks: z.record(z.string(), z.unknown()).optional(),
});

export const NotifyRequest = z.object({
  notification: z.object({
    event_id: z.string().min(1).max(255).optional(),
    room_id: z.string().min(1).max(255).optional(),
    type: z.string().max(255).nullish(),
    sender: z.string().max(255).nullish(),
    sender_display_name: z.string().max(1024).nullish(),
    room_name: z.string().max(1024).nullish(),
    room_alias: z.string().max(255).nullish(),
    user_is_target: z.boolean().nullish(),
    prio: z.enum(["high", "low"]).optional(),
    content: z.record(z.string(), z.unknown()).nullish(),
    counts: z
      .object({
        unread: z.number().int().nonnegative().max(1_000_000).optional(),
        missed_calls: z.number().int().nonnegative().max(1_000_000).optional(),
      })
      .optional(),
    devices: z.array(NotifyDevice).min(1).max(20),
  }),
});
export type NotifyRequest = z.infer<typeof NotifyRequest>;
type Notification = NotifyRequest["notification"];

/** An APNs device token as supermessage registers it: lowercase hex. */
const APNS_TOKEN = /^[0-9a-f]{64,200}$/;

/** Enough of a pushkey to find it in a log, never enough to use it. */
export function pushkeyPrefix(pushkey: string): string {
  return `${pushkey.slice(0, 8)}…`;
}

// ─── The payload ─────────────────────────────────────────────────────────────

/** What the hub knows an event to be, as a push category. */
export function categoryFor(eventId: string | undefined): PushCategory | undefined {
  return categoryOf(hubEventKind(eventId));
}

function categoryOf(kind: HubEventKind | undefined): PushCategory | undefined {
  if (kind === "permission") return "PERMISSION";
  if (kind === "gate") return "GATE";
  return undefined;
}

/**
 * The APNs body for one notification. Built ONLY from ids, a count, a
 * category and — for an answer that ended a turn — the turn's tool counts; no
 * field of `notification` that could carry what was said is read here, and
 * the contract's strict schema is the check that it stays so.
 */
export function buildApnsPayload(
  n: Notification,
  category: PushCategory | undefined,
  turn?: TurnCounts
): ApnsPushPayload {
  const unread = n.counts?.unread;
  const payload: ApnsPushPayload = {
    aps: {
      alert: { title: PUSH_ALERT_TITLE, body: PUSH_ALERT_BODY },
      "mutable-content": 1,
      sound: "default",
      ...(unread !== undefined ? { badge: unread } : {}),
      ...(n.room_id ? { "thread-id": n.room_id } : {}),
      ...(category ? { category, "interruption-level": "time-sensitive" as const } : {}),
    },
    ...(n.room_id ? { room_id: n.room_id } : {}),
    ...(n.event_id ? { event_id: n.event_id } : {}),
    ...(unread !== undefined ? { unread_count: unread } : {}),
    ...(turn ? { turn: { total: turn.total, failed: turn.failed } } : {}),
  };
  // Throws on anything the contract does not list — a payload that fails here
  // is a bug in this function, and it must not reach Apple.
  return ApnsPushPayload.parse(payload);
}

// ─── Per-pushkey rate limit ──────────────────────────────────────────────────

/**
 * A fixed window per pushkey. The route is unauthenticated, so without this
 * anyone who learned a device token could make that phone buzz on demand.
 * Over the limit a push is dropped, not rejected — the device is fine.
 */
export function createPushkeyLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    allow(pushkey: string): boolean {
      const t = now();
      let w = windows.get(pushkey);
      if (!w || w.resetAt <= t) {
        if (windows.size > 10_000) {
          for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
        }
        w = { count: 0, resetAt: t + windowMs };
        windows.set(pushkey, w);
      }
      w.count++;
      return w.count <= limit;
    },
  };
}

// ─── The gateway ─────────────────────────────────────────────────────────────

/** How long Apple keeps trying a push the phone is not there to receive. */
export const APNS_EXPIRATION_S = 24 * 60 * 60;
/** `apns-collapse-id` is at most 64 bytes; a longer event id is sent without one. */
const COLLAPSE_ID_MAX = 64;

/**
 * The longest a push waits for a quiet send in its room to return its event id.
 *
 * Only a push whose event id is unknown AND whose room has a quiet send in
 * flight waits at all; everything else is decided at once. So this bounds the
 * delay an ordinary message can pick up by landing beside a hub reaction, and
 * it is what stands between a reaction and an empty buzz when the homeserver
 * pushes before the send's response arrives.
 *
 * Measured against tuwunel 1.9.3 (2026-09-28, 50 turns, pusher over HTTP to a
 * gateway on the same machine): 16 of 50 turn records were pushed BEFORE the
 * send's response reached the hub — without a wait each would have buzzed —
 * and every one of them became known within 1 ms of waiting. In production
 * the hub reaches tuwunel on 127.0.0.1 while the push comes back through
 * nginx and TLS, which only favours the send. 500 ms is two orders of
 * magnitude of headroom for a hub whose event loop is busy, and still short
 * enough that an ordinary message held beside a hung quiet send is late by
 * half a second at worst.
 */
export const QUIET_WAIT_MS = 500;

/**
 * How a push's event came to be known, for the debug log that measures the
 * race between a hub send's response and the homeserver's push:
 * - `known-before`: the id was noted before the push arrived;
 * - `known-after-wait`: a quiet send was in flight and its id arrived in time;
 * - `unknown`: never noted — an ordinary message (sent after `waitedMs`, 0
 *   unless a quiet send was in flight in its room).
 */
export type PushDecisionTiming = "known-before" | "known-after-wait" | "unknown";

export interface PushGatewayDeps {
  apns: ApnsClient;
  appIds: ReadonlyMap<string, ApnsEnvironment>;
  limiter?: ReturnType<typeof createPushkeyLimiter>;
  now?: () => number;
  /** Overrides `QUIET_WAIT_MS`. */
  quietWaitMs?: number;
  /** Told every decision, as the debug log is. For tests and measurement. */
  onDecision?: (d: PushDecision) => void;
}

export interface PushDecision {
  eventId: string;
  kind: HubEventKind | undefined;
  timing: PushDecisionTiming;
  waitedMs: number;
}

export type PushGateway = ReturnType<typeof createPushGateway>;

export function createPushGateway(deps: PushGatewayDeps) {
  const limiter = deps.limiter ?? createPushkeyLimiter(60, 60_000);
  const now = deps.now ?? Date.now;
  const quietWaitMs = deps.quietWaitMs ?? QUIET_WAIT_MS;

  /** What the hub knows the event to be — waiting, bounded, if it may be about to. */
  async function classify(n: Notification): Promise<Omit<PushDecision, "eventId">> {
    const known = hubEventKind(n.event_id);
    if (known) return { kind: known, timing: "known-before", waitedMs: 0 };
    if (quietSendsInFlight(n.room_id) === 0) return { kind: undefined, timing: "unknown", waitedMs: 0 };
    const started = Date.now();
    await quietSendsSettled(n.room_id, n.event_id, quietWaitMs);
    const waitedMs = Date.now() - started;
    const kind = hubEventKind(n.event_id);
    return { kind, timing: kind ? "known-after-wait" : "unknown", waitedMs };
  }

  /** Push one notification to each of its devices. Returns the rejected pushkeys. */
  async function notify(n: Notification): Promise<{ rejected: string[] }> {
    // A counts-only notice — tuwunel's badge refresh after a read, with no
    // event at all. There is nothing for the extension to fetch, and an alert
    // for it is a buzz about nothing.
    if (!n.event_id) {
      log.debug("push without an event (a counts-only badge refresh) dropped", { roomId: n.room_id });
      return { rejected: [] };
    }

    const { kind, timing, waitedMs } = await classify(n);
    log.debug("push decision", { eventId: n.event_id, roomId: n.room_id, kind: kind ?? "message", timing, waitedMs });
    deps.onDecision?.({ eventId: n.event_id, kind, timing, waitedMs });

    // Answered as delivered, never rejected: a rejection would make the
    // homeserver delete the device's pusher.
    //
    // The legacy custom event beside a question's prose: the prose already
    // pushed, and one question should buzz once.
    if (kind === "companion") {
      log.debug("push for a legacy companion event dropped", { eventId: n.event_id });
      return { rejected: [] };
    }
    // The hub's own reaction or turn record: nothing a person should be told.
    if (kind === "quiet") {
      log.debug("push for a quiet hub event dropped", { eventId: n.event_id });
      return { rejected: [] };
    }

    const category = categoryOf(kind);
    const turn = kind === "answer" ? hubEventTurn(n.event_id) : undefined;
    const payload = buildApnsPayload(n, category, turn);
    const collapseId =
      n.event_id && Buffer.byteLength(n.event_id) <= COLLAPSE_ID_MAX ? n.event_id : undefined;
    const expiration = Math.floor(now() / 1000) + APNS_EXPIRATION_S;

    const rejected: string[] = [];
    await Promise.all(
      n.devices.map(async (device) => {
        const environment = deps.appIds.get(device.app_id);
        const who = { appId: device.app_id, pushkey: pushkeyPrefix(device.pushkey) };
        if (!environment) {
          // Not rejected: that would make the homeserver delete a pusher over
          // this hub's configuration, which the next deploy may fix.
          log.warn("push for an app id this gateway does not serve; dropped", who);
          return;
        }
        if (!APNS_TOKEN.test(device.pushkey)) {
          // Can never become deliverable, so the pusher should go.
          log.warn("pushkey is not an APNs device token; rejected", who);
          rejected.push(device.pushkey);
          return;
        }
        if (!limiter.allow(device.pushkey)) {
          log.warn("pushkey over its rate limit; dropped", who);
          return;
        }
        const outcome = await deps.apns.send({
          environment,
          deviceToken: device.pushkey,
          priority: n.prio === "low" ? 5 : 10,
          collapseId,
          expiration,
          payload,
        });
        if (outcome.status === "rejected") {
          log.info("APNs says the device token is dead; rejected", { ...who, reason: outcome.reason });
          rejected.push(device.pushkey);
        } else if (outcome.status === "failed") {
          log.warn("APNs push failed", { ...who, reason: outcome.reason });
        }
      })
    );
    return { rejected };
  }

  return { notify };
}
