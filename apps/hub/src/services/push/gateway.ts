/**
 * The Matrix push gateway: a homeserver's notify in, one APNs push per device out.
 *
 * Operator decision 2026-09-28: the gateway lives in the hub rather than in
 * Sygnal. The pusher supermessage registers is `format: "event_id_only"`, so
 * what arrives is an event id, a room id and an unread count — and that, plus
 * a category when the hub itself asked the question, is all that leaves. The
 * app's Notification Service Extension fetches and decrypts the event.
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
import { hubEventKind } from "./hub-events";

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
  const kind = hubEventKind(eventId);
  if (kind === "permission") return "PERMISSION";
  if (kind === "gate") return "GATE";
  return undefined;
}

/**
 * The APNs body for one notification. Built ONLY from ids, a count and a
 * category — no field of `notification` that could carry what was said is
 * read here, and the contract's strict schema is the check that it stays so.
 */
export function buildApnsPayload(n: Notification, category: PushCategory | undefined): ApnsPushPayload {
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

export interface PushGatewayDeps {
  apns: ApnsClient;
  appIds: ReadonlyMap<string, ApnsEnvironment>;
  limiter?: ReturnType<typeof createPushkeyLimiter>;
  now?: () => number;
}

export type PushGateway = ReturnType<typeof createPushGateway>;

export function createPushGateway(deps: PushGatewayDeps) {
  const limiter = deps.limiter ?? createPushkeyLimiter(60, 60_000);
  const now = deps.now ?? Date.now;

  /** Push one notification to each of its devices. Returns the rejected pushkeys. */
  async function notify(n: Notification): Promise<{ rejected: string[] }> {
    // The legacy custom event beside a question's prose: the prose already
    // pushed, and one question should buzz once.
    if (hubEventKind(n.event_id) === "companion") {
      log.debug("push for a legacy companion event dropped", { eventId: n.event_id });
      return { rejected: [] };
    }

    const category = categoryFor(n.event_id);
    const payload = buildApnsPayload(n, category);
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
