/**
 * When the fleet card is pushed, and what each push is — pure.
 *
 * One reader's push state and the fleet's current content in; the push to
 * make (if any), the new push state, and when to look again out. `service.ts`
 * owns the clock, the timers, the tokens and APNs; everything that decides
 * lives here so it can be tested without any of them. Spec A2/A3.
 *
 * The phases of one reader's card:
 * - `idle`: no activity the hub knows of. An active fleet starts one — on
 *   the reader's push-to-start tokens — only when no update token is
 *   registered (spec A3's start rule); with one, the activity is already up.
 * - `starting`: a start went out and the app has not registered the new
 *   activity's update token yet. Changes are held, not re-started; the latest
 *   state goes the moment the token arrives (`planForNewUpdateToken`).
 * - `live`: updates go to the update tokens, coalesced (spec A2).
 * - `dismissed`: the app said its activity ended (the person swiped it away)
 *   while the fleet was still active. Nothing is pushed until the fleet goes
 *   quiet, or every buzz would put back a card they just removed.
 */

import {
  FLEET_ATTRIBUTES_TYPE,
  LIVE_ACTIVITY_PAYLOAD_MAX_BYTES,
  type FleetContentState,
  type LiveActivityPushPayload,
} from "@agentpod/contract";

import { ACTIVE_WITHIN_MS, bound, type FleetChange } from "./state";

/** At most one routine update per reader in this window (spec A2). */
export const COALESCE_MS = 3_000;
/** An update's `stale-date`: after this long with no push the app says "Waiting for updates". */
export const STALE_AFTER_S = 15 * 60;
/** After a finished turn, the ended card stays on the Lock Screen this long (spec A2). */
export const LINGER_AFTER_FINISH_S = 120;

export type Phase = "idle" | "starting" | "live" | "dismissed";

export interface ReaderPlan {
  phase: Phase;
  lastSentAt: number | null;
  /** What the card last showed — the end carries it, so an ended card is not blank. */
  lastSent: FleetContentState | null;
  /** Unix seconds of the last push, so `aps.timestamp` only moves forward. */
  lastTimestamp: number;
  /** A routine update held by the coalescing window. */
  dueAt: number | null;
}

export function initialPlan(): ReaderPlan {
  return { phase: "idle", lastSentAt: null, lastSent: null, lastTimestamp: 0, dueAt: null };
}

/** After a hub restart, for a reader with update tokens on file: an activity may be up. */
export function restoredPlan(): ReaderPlan {
  return { ...initialPlan(), phase: "live" };
}

export interface PlanInput {
  readerId: string;
  now: number;
  content: FleetContentState;
  active: boolean;
  /** What the event that prompted this did; `none` for a timer or a token. */
  change: FleetChange;
  endedOnFinish: boolean;
  /** The fleet's own next change (`nextExpiry`), or null. */
  expiryAt: number | null;
  tokens: { start: boolean; update: boolean };
}

/** `new-token`: only the update token that just registered. */
export type PushTarget = "start-tokens" | "update-tokens" | "new-token";

export interface PlannedPush {
  target: PushTarget;
  priority: 5 | 10;
  payload: LiveActivityPushPayload;
}

export interface PlanResult {
  plan: ReaderPlan;
  push: PlannedPush | null;
  /** When `service.ts` should call `planPush` again, with `change: "none"`. */
  wakeAt: number | null;
}

/** Content with the clock left out — two pushes that differ only in `updatedAt` are the same card. */
function sameCard(a: FleetContentState | null, b: FleetContentState): boolean {
  if (!a) return false;
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
}

function earliest(...times: Array<number | null>): number | null {
  const set = times.filter((t): t is number => t !== null);
  return set.length ? Math.min(...set) : null;
}

function nextTimestamp(plan: ReaderPlan, now: number): number {
  return Math.max(Math.floor(now / 1000), plan.lastTimestamp + 1);
}

// ─── Payloads ────────────────────────────────────────────────────────────────

function startAlert(c: FleetContentState): { title: string; body: string } {
  const first = c.agents[0];
  if (!first && c.decision) return { title: c.decision.agent, body: c.decision.question };
  if (!first) return { title: "Your agents", body: "Working" };
  const asks = first.state === "needs_you" && c.decision?.roomId === first.roomId ? c.decision.question : undefined;
  return { title: first.name, body: asks ?? first.step ?? STATE_WORDS[first.state] };
}

const STATE_WORDS = { working: "Working", needs_you: "Needs you", active: "Active", done: "Done", failed: "Failed" };

function startPayload(readerId: string, c: FleetContentState, ts: number): LiveActivityPushPayload {
  return {
    aps: {
      timestamp: ts,
      event: "start",
      "attributes-type": FLEET_ATTRIBUTES_TYPE,
      attributes: { readerId },
      "content-state": c,
      alert: startAlert(c),
      // Not in the spec's start shape, and harmless there: a card whose update
      // token never reaches the hub has nothing else that will say it is stale.
      "stale-date": ts + STALE_AFTER_S,
    },
  };
}

/**
 * An update never alerts — operator decision 2026-09-29: a decision arriving
 * is buzzed by its ordinary message notification, and the card only changes
 * (at priority 10, so promptly). Only a push-to-start carries an alert, which
 * APNs requires.
 */
function updatePayload(c: FleetContentState, ts: number): LiveActivityPushPayload {
  return {
    aps: {
      timestamp: ts,
      event: "update",
      "content-state": c,
      "stale-date": ts + STALE_AFTER_S,
    },
  };
}

function endPayload(c: FleetContentState, ts: number, dismissAt: number): LiveActivityPushPayload {
  return { aps: { timestamp: ts, event: "end", "content-state": c, "dismissal-date": dismissAt } };
}

const bytes = (p: unknown) => Buffer.byteLength(JSON.stringify(p));

/**
 * Cut a payload down to Apple's 4 KB. Real ids are short and every text field
 * is already bounded, so this only bites on pathological input — but a push
 * over the limit is refused outright, so it is checked on every one.
 * Rows go first (into `more`), then the alert's body, then the question; the
 * decision itself goes last, because it is the one thing on the card owed.
 */
export function fitPayload(payload: LiveActivityPushPayload): LiveActivityPushPayload {
  if (bytes(payload) <= LIVE_ACTIVITY_PAYLOAD_MAX_BYTES) return payload;
  const aps = { ...payload.aps };
  let cs = { ...aps["content-state"], agents: [...aps["content-state"].agents] };
  const fits = () => bytes({ aps: { ...aps, "content-state": cs } }) <= LIVE_ACTIVITY_PAYLOAD_MAX_BYTES;

  while (!fits() && cs.agents.length > 0) {
    cs.agents.pop();
    cs.more += 1;
  }
  if (!fits() && aps.alert) aps.alert = { title: bound(aps.alert.title, 20), body: bound(aps.alert.body, 40) };
  if (!fits() && cs.decision) cs = { ...cs, decision: { ...cs.decision, question: bound(cs.decision.question, 40) } };
  if (!fits() && cs.decision) cs = { ...cs, decision: { ...cs.decision, options: [] } };
  if (!fits()) {
    const { decision: _dropped, ...rest } = cs;
    cs = rest;
  }
  return { aps: { ...aps, "content-state": cs } };
}

// ─── Planning ────────────────────────────────────────────────────────────────

function end(plan: ReaderPlan, i: PlanInput, target: PushTarget): PlanResult {
  const ts = nextTimestamp(plan, i.now);
  const shown = { ...(plan.lastSent ?? i.content), updatedAt: Math.floor(i.now / 1000) };
  const dismissAt = i.endedOnFinish ? ts + LINGER_AFTER_FINISH_S : ts;
  return {
    plan: { ...initialPlan(), lastTimestamp: ts },
    push: { target, priority: 10, payload: fitPayload(endPayload(shown, ts, dismissAt)) },
    wakeAt: null,
  };
}

function sendUpdate(plan: ReaderPlan, i: PlanInput, target: PushTarget, priority: 5 | 10): PlanResult {
  const ts = nextTimestamp(plan, i.now);
  return {
    plan: { ...plan, phase: "live", lastSentAt: i.now, lastSent: i.content, lastTimestamp: ts, dueAt: null },
    push: { target, priority, payload: fitPayload(updatePayload(i.content, ts)) },
    wakeAt: i.expiryAt,
  };
}

export function planPush(plan: ReaderPlan, i: PlanInput): PlanResult {
  if (!i.active) {
    // Priority 10 on the end: it is the push that clears the Lock Screen.
    if (plan.phase === "live" && i.tokens.update) return end(plan, i, "update-tokens");
    return { plan: { ...initialPlan(), lastTimestamp: plan.lastTimestamp }, push: null, wakeAt: null };
  }

  switch (plan.phase) {
    case "dismissed":
      return { plan, push: null, wakeAt: i.expiryAt };

    case "idle":
    case "starting": {
      if (i.tokens.update) {
        // An activity is up — after a restart, or the start's token arrived.
        return sendUpdate(plan, i, "update-tokens", i.change === "important" ? 10 : 5);
      }
      if (plan.phase === "starting" || !i.tokens.start) {
        return { plan, push: null, wakeAt: i.expiryAt };
      }
      const ts = nextTimestamp(plan, i.now);
      return {
        plan: { ...plan, phase: "starting", lastSentAt: i.now, lastSent: i.content, lastTimestamp: ts, dueAt: null },
        push: { target: "start-tokens", priority: 10, payload: fitPayload(startPayload(i.readerId, i.content, ts)) },
        wakeAt: i.expiryAt,
      };
    }

    case "live": {
      if (!i.tokens.update) {
        // Every update token went (APNs refused them): nothing is up any more.
        return planPush({ ...plan, phase: "idle" }, i);
      }
      if (sameCard(plan.lastSent, i.content)) {
        return { plan: { ...plan, dueAt: null }, push: null, wakeAt: i.expiryAt };
      }
      if (i.change === "important") return sendUpdate(plan, i, "update-tokens", 10);
      if (i.change === "flush") return sendUpdate(plan, i, "update-tokens", 5);
      const openAt = plan.lastSentAt === null ? i.now : plan.lastSentAt + COALESCE_MS;
      if (i.now >= openAt) return sendUpdate(plan, i, "update-tokens", 5);
      return { plan: { ...plan, dueAt: openAt }, push: null, wakeAt: earliest(openAt, i.expiryAt) };
    }
  }
}

/**
 * An update token just registered. It gets the card as it stands now — the
 * gap between a start and its token (spec A3) is closed here — or, when the
 * fleet already went quiet, the end.
 */
export function planForNewUpdateToken(plan: ReaderPlan, i: PlanInput): PlanResult {
  if (plan.phase === "dismissed") return { plan, push: null, wakeAt: i.expiryAt };
  if (!i.active) {
    // The card this hub started, for a fleet that went quiet before its token came.
    if (plan.phase === "starting") return end({ ...plan, phase: "live" }, i, "new-token");
    // A card this hub knows nothing of — the app relaunched with one up, most
    // likely across a hub restart that emptied this state. Treated as restored:
    // updated if work arrives, ended if none does within the active window.
    return { plan: { ...plan, phase: "live", dueAt: null }, push: null, wakeAt: i.now + ACTIVE_WITHIN_MS + 1 };
  }
  return sendUpdate(plan, i, "new-token", 5);
}

/** The app deleted its last update token: its activity ended on the phone. */
export function planTokensGone(plan: ReaderPlan, active: boolean): ReaderPlan {
  return { ...plan, phase: active ? "dismissed" : "idle", dueAt: null };
}
