/**
 * The fleet Live Activity, wired: the thin shell around `state.ts` and
 * `planner.ts` that owns the clock, the timers, the tokens and APNs.
 *
 * Per reader — the station owner (`readerForRoom`), as for the to-device live
 * events — it keeps a `FleetState` and a push plan, applies each event the
 * hub's Matrix path reports (`sink.ts`), and pushes what the planner says.
 * Work for one reader is serialised, so an event, a timer and a token
 * registration can never interleave half-way through a plan.
 *
 * **Plaintext to Apple, by operator decision 2026-09-29.** What this pushes —
 * agent names, step titles, a decision's question and options — is readable
 * by Apple in transit. The message gateway (`gateway.ts`) still sends ids
 * only; this is the one deliberate exception.
 *
 * In memory. A restart forgets every reader's state (pending permissions are
 * in memory anyway); live state is rebuilt from new events. `restore()`
 * picks up readers whose card may still be up and ends it if nothing
 * happens within the active window.
 */

import { createLogger } from "../../../utils/logger";
import type { ApnsClient } from "../apns";
import {
  initialPlan,
  planForNewUpdateToken,
  planPush,
  planTokensGone,
  restoredPlan,
  type PlanInput,
  type PlannedPush,
  type ReaderPlan,
} from "./planner";
import {
  ACTIVE_WITHIN_MS,
  applyFleetEvent,
  contentState,
  emptyFleet,
  endedOnFinish,
  isFleetActive,
  nextExpiry,
  pruneFleet,
  type FleetChange,
  type FleetEvent,
  type FleetState,
} from "./state";
import type { LiveActivityToken, LiveActivityTokenKind, LiveActivityTokenStore } from "./tokens";

const log = createLogger("fleet-live");

/** How long Apple holds a Live Activity push for a phone that is not there. */
export const LIVE_ACTIVITY_EXPIRATION_S = 60 * 60;

export interface FleetServiceDeps {
  apns: Pick<ApnsClient, "send">;
  tokens: LiveActivityTokenStore;
  now?: () => number;
  /** Timer seam: run `fn` in `ms`; returns the cancel. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

interface Reader {
  fleet: FleetState;
  plan: ReaderPlan;
  cancelWake: (() => void) | null;
  chain: Promise<void>;
}

export type FleetService = ReturnType<typeof createFleetService>;

function realTimer(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  // A pending wake must not hold the process open at shutdown.
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
}

export function createFleetService(deps: FleetServiceDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? realTimer;
  const readers = new Map<string, Reader>();
  const inflight = new Set<Promise<void>>();

  function reader(id: string): Reader {
    let r = readers.get(id);
    if (!r) {
      r = { fleet: emptyFleet(), plan: initialPlan(), cancelWake: null, chain: Promise.resolve() };
      readers.set(id, r);
    }
    return r;
  }

  /** Run `task` after everything already queued for this reader. Never rejects. */
  function enqueue(id: string, task: (r: Reader) => Promise<void>): Promise<void> {
    const r = reader(id);
    const run = r.chain.then(() => task(r)).catch((err) => {
      log.error("fleet live activity work failed", {
        reader: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    r.chain = run;
    inflight.add(run);
    void run.finally(() => inflight.delete(run));
    return run;
  }

  function inputFor(id: string, r: Reader, t: number, change: FleetChange, newDecision: boolean, list: LiveActivityToken[]): PlanInput {
    return {
      readerId: id,
      now: t,
      content: contentState(r.fleet, t),
      active: isFleetActive(r.fleet, t),
      change,
      newDecision,
      endedOnFinish: endedOnFinish(r.fleet),
      expiryAt: nextExpiry(r.fleet, t),
      tokens: { start: list.some((k) => k.kind === "start"), update: list.some((k) => k.kind === "update") },
    };
  }

  async function push(id: string, planned: PlannedPush, targets: LiveActivityToken[], t: number): Promise<void> {
    const expiration = Math.floor(t / 1000) + LIVE_ACTIVITY_EXPIRATION_S;
    await Promise.all(
      targets.map(async (target) => {
        const outcome = await deps.apns.send({
          environment: target.environment,
          deviceToken: target.token,
          pushType: "liveactivity",
          priority: planned.priority,
          expiration,
          payload: planned.payload,
        });
        const who = { reader: id, kind: target.kind, event: planned.payload.aps.event, token: `${target.token.slice(0, 8)}…` };
        if (outcome.status === "rejected") {
          log.info("APNs says a Live Activity token is dead; deleted", { ...who, reason: outcome.reason });
          await deps.tokens.removeToken(id, target.token);
        } else if (outcome.status === "failed") {
          log.warn("Live Activity push failed", { ...who, reason: outcome.reason });
        } else if (planned.payload.aps.event === "end" && target.kind === "update") {
          // The activity is over; its token will never be good for another update.
          await deps.tokens.removeToken(id, target.token);
        }
      })
    );
  }

  function scheduleWake(id: string, r: Reader, wakeAt: number | null, t: number): void {
    r.cancelWake?.();
    r.cancelWake = null;
    if (wakeAt === null) return;
    r.cancelWake = setTimer(() => {
      r.cancelWake = null;
      void enqueue(id, (rr) => replan(id, rr, "none", false));
    }, Math.max(0, wakeAt - t));
  }

  function forgetIfIdle(id: string, r: Reader): void {
    if (r.plan.phase === "idle" && r.fleet.agents.size === 0 && r.fleet.decisions.size === 0 && !r.cancelWake) {
      readers.delete(id);
    }
  }

  async function replan(id: string, r: Reader, change: FleetChange, newDecision: boolean): Promise<void> {
    const t = now();
    const list = await deps.tokens.list(id);
    const result = planPush(r.plan, inputFor(id, r, t, change, newDecision, list));
    r.plan = result.plan;
    if (result.push) {
      const kind: LiveActivityTokenKind = result.push.target === "start-tokens" ? "start" : "update";
      await push(id, result.push, list.filter((k) => k.kind === kind), t);
    }
    // Pruned after planning, not before: an end needs to know the last turn finished.
    r.fleet = pruneFleet(r.fleet, t);
    scheduleWake(id, r, result.wakeAt, t);
    forgetIfIdle(id, r);
  }

  return {
    /** Something happened in one of this reader's rooms. */
    note(readerId: string, event: FleetEvent): void {
      void enqueue(readerId, async (r) => {
        const { state, change } = applyFleetEvent(r.fleet, event);
        r.fleet = state;
        if (change === "none") return;
        await replan(readerId, r, change, event.type === "decision-asked");
      });
    },

    /** A decision was answered or withdrawn, wherever it was shown. */
    clearDecision(key: string): void {
      for (const [id, r] of readers) {
        if (r.fleet.decisions.has(key)) this.note(id, { type: "decision-cleared", key });
      }
    },

    /** A sweep of `boardId` found these gates still pending: the others on that board are closed. */
    reconcileGates(boardId: string, pendingGateIds: ReadonlySet<string>): void {
      for (const [id, r] of readers) {
        for (const d of r.fleet.decisions.values()) {
          if (d.kind === "gate" && d.boardId === boardId && !pendingGateIds.has(d.key.slice("gate:".length))) {
            this.note(id, { type: "decision-cleared", key: d.key });
          }
        }
      }
    },

    knowsDecision(key: string): boolean {
      for (const r of readers.values()) if (r.fleet.decisions.has(key)) return true;
      return false;
    },

    /** The app registered a token (A1). An update token gets the card as it stands, at once. */
    tokenRegistered(t: LiveActivityToken): Promise<void> {
      return enqueue(t.userId, async (r) => {
        await deps.tokens.upsert(t);
        if (t.kind === "start") {
          await replan(t.userId, r, "none", false);
          return;
        }
        const at = now();
        const list = await deps.tokens.list(t.userId);
        const result = planForNewUpdateToken(r.plan, inputFor(t.userId, r, at, "none", false, list));
        r.plan = result.plan;
        const target = list.find((k) => k.kind === "update" && k.token === t.token.toLowerCase());
        if (result.push && target) await push(t.userId, result.push, [target], at);
        scheduleWake(t.userId, r, result.wakeAt, at);
        forgetIfIdle(t.userId, r);
      });
    },

    /** The app deleted a token (A1): its activity ended on the phone, or it signed out. */
    tokensRemoved(
      userId: string,
      key: { kind: LiveActivityTokenKind; deviceId: string; activityId?: string }
    ): Promise<number> {
      let removed = 0;
      return enqueue(userId, async (r) => {
        removed = await deps.tokens.remove(userId, key);
        if (key.kind !== "update") return;
        const left = (await deps.tokens.list(userId)).some((k) => k.kind === "update");
        if (!left && r.plan.phase !== "idle") r.plan = planTokensGone(r.plan, isFleetActive(r.fleet, now()));
        forgetIfIdle(userId, r);
      }).then(() => removed);
    },

    /**
     * After a restart: a reader with update tokens on file may still have a
     * card up, showing whatever it last showed. It is updated if work arrives,
     * and ended if nothing does within the active window.
     */
    async restore(): Promise<void> {
      const ids = await deps.tokens.readersWithUpdateTokens();
      for (const id of ids) {
        await enqueue(id, async (r) => {
          r.plan = restoredPlan();
          const t = now();
          scheduleWake(id, r, t + ACTIVE_WITHIN_MS + 1, t);
        });
      }
      if (ids.length > 0) log.info("fleet live activities to pick back up", { readers: ids.length });
    },

    /** Resolves once all queued work has run. For tests and shutdown. */
    async settled(): Promise<void> {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },

    stop(): void {
      for (const r of readers.values()) r.cancelWake?.();
      readers.clear();
    },
  };
}
