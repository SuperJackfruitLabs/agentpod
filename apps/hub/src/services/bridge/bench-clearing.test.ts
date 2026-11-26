import { expect, spyOn, test } from "bun:test";
import { ABANDON_AFTER_MS, cardReadFromError, cardReadFromView, clearingReason, dormantAfterMs, sweepBenchClearing,
  type BenchedCard, type CardAttempt, type CardRead, type ClearingDeps, type ClearingReason } from "./bench-clearing";
import { reclaimCardBench, type ReclaimDeps, type ReclaimOutcome, type ReclaimTarget } from "./checkpoint-reclaim";
import { SuperpipelineApiError } from "./superpipeline";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const DORMANT = 72 * HOUR;

let seq = 0;
function attempt(over: Partial<CardAttempt<null>> = {}): CardAttempt<null> {
  seq++;
  return { tenantId: "fleet_t", boardId: "brd_b", cardId: "card_1", stationId: "stn_s", nodeId: "node_a", runId: `run_${seq}`,
    attemptId: `attempt_${String(seq).padStart(4, "0")}`, phase: "reported", createdAtMs: NOW - 2 * HOUR + seq, updatedAtMs: NOW - HOUR, source: null, ...over };
}

/** A fake ledger, board and node: the board answers `read` for every card. */
function world(read: (card: string) => CardRead, cards: BenchedCard<null>[], over: Partial<ClearingDeps<null>> = {}) {
  const reclaimed: Array<ReclaimTarget & { reason: ClearingReason }> = [];
  const recorded: Array<{ attemptIds: string[]; reason: ClearingReason; outcome: string }> = [];
  const reads: string[] = [];
  let ledger = cards;
  const deps: ClearingDeps<null> = {
    cards: async () => ledger.map((c) => ({ attempts: c.attempts.filter((a) => !recorded.some((r) => r.attemptIds.includes(a.attemptId))) }))
      .filter((c) => c.attempts.length > 0),
    readCard: async (a) => { reads.push(a.cardId); return read(a.cardId); },
    keepBench: async () => false,
    reclaim: async (target, reason) => { reclaimed.push({ ...target, reason }); return "reclaimed"; },
    record: async (attempts, reason, outcome) => { recorded.push({ attemptIds: attempts.map((a) => a.attemptId), reason, outcome }); },
    now: () => NOW, dormantMs: DORMANT, ...over,
  };
  return { deps, reclaimed, recorded, reads, set: (next: BenchedCard<null>[]) => { ledger = next; } };
}
const card = (state: string, extra: Partial<Extract<CardRead, { kind: "card" }>> = {}): CardRead =>
  ({ kind: "card", state, archived: false, updatedAtMs: NOW - HOUR, ...extra });

// ─── the ruling, case by case ───────────────────────────────────────────────

test("revert-proof: a settled card that is still on the board keeps its bench (no reclaim, nothing recorded)", async () => {
  for (const state of ["submitted", "working", "input-required"]) {
    const w = world(() => card(state), [{ attempts: [attempt()] }]);
    expect((await sweepBenchClearing(w.deps)).map((r) => r.outcome)).toEqual(["warm"]);
    expect(w.reclaimed).toEqual([]);
    expect(w.recorded).toEqual([]);
  }
});

test("a done card's bench is cleared: completed, and rejected or failed (terminal)", async () => {
  for (const [state, reason] of [["completed", "completed"], ["rejected", "terminal"], ["failed", "terminal"]] as const) {
    const a = attempt();
    const w = world(() => card(state), [{ attempts: [a] }]);
    expect(await sweepBenchClearing(w.deps)).toEqual([{ cardId: "card_1", outcome: "cleared", reason }]);
    expect(w.reclaimed).toEqual([{ nodeId: "node_a", tenantId: "fleet_t", boardId: "brd_b", stationId: "stn_s", cardId: "card_1", reason }]);
    expect(w.recorded).toEqual([{ attemptIds: [a.attemptId], reason, outcome: "reclaimed" }]);
  }
});

test("a cancelled card's bench is cleared: canceled, archived, or deleted (the board answers 404)", async () => {
  for (const read of [card("canceled"), card("submitted", { archived: true }), { kind: "gone", code: "CARD_NOT_FOUND" } as const]) {
    const w = world(() => read, [{ attempts: [attempt()] }]);
    expect((await sweepBenchClearing(w.deps))[0]).toMatchObject({ outcome: "cleared", reason: "cancelled" });
    expect(w.reclaimed).toHaveLength(1);
  }
});

test("a dormant card's bench is cleared; a card or attempt that changed within the limit is not; 0 turns dormancy off", async () => {
  const old = attempt({ updatedAtMs: NOW - DORMANT - HOUR });
  const dormant = world(() => card("input-required", { updatedAtMs: NOW - DORMANT - 1 }), [{ attempts: [old] }]);
  expect((await sweepBenchClearing(dormant.deps))[0]).toMatchObject({ outcome: "cleared", reason: "dormant" });
  // The card changed recently (a review in progress): still warm.
  const reviewed = world(() => card("input-required", { updatedAtMs: NOW - HOUR }), [{ attempts: [attempt({ updatedAtMs: NOW - DORMANT - HOUR })] }]);
  expect((await sweepBenchClearing(reviewed.deps))[0]?.outcome).toBe("warm");
  // An unreadable card falls back on its attempts' age alone.
  const unread = world(() => ({ kind: "unknown" }), [{ attempts: [attempt({ updatedAtMs: NOW - DORMANT - HOUR })] }]);
  expect((await sweepBenchClearing(unread.deps))[0]).toMatchObject({ outcome: "cleared", reason: "dormant" });
  const off = world(() => card("input-required", { updatedAtMs: 0 }), [{ attempts: [attempt({ updatedAtMs: 0 })] }], { dormantMs: 0 });
  expect((await sweepBenchClearing(off.deps))[0]?.outcome).toBe("warm");
  expect(off.reclaimed).toEqual([]);
});

test("revert-proof: a review bounce reuses the warm bench: nothing is cleared until the card is done", async () => {
  const first = attempt({ runId: "run_build1" });
  const w = world(() => card("input-required"), [{ attempts: [first] }]);
  // Settled on the build stage, now in review.
  await sweepBenchClearing(w.deps);
  // The review sent it back: the build stage claimed it again, and that attempt owns the bench.
  const again = attempt({ runId: "run_build2", phase: "execute_pending" });
  w.set([{ attempts: [first, again] }]);
  w.deps.readCard = async () => card("working");
  expect((await sweepBenchClearing(w.deps))[0]?.outcome).toBe("unsettled");
  // Settled again, back in review.
  const settled = { ...again, phase: "reported" };
  w.set([{ attempts: [first, settled] }]);
  w.deps.readCard = async () => card("input-required");
  expect((await sweepBenchClearing(w.deps))[0]?.outcome).toBe("warm");
  expect(w.reclaimed).toEqual([]);
  // Approved and done: cleared once, for both attempts.
  w.deps.readCard = async () => card("completed");
  await sweepBenchClearing(w.deps);
  expect(w.reclaimed.map((t) => t.reason)).toEqual(["completed"]);
  expect(w.recorded).toEqual([{ attemptIds: [first.attemptId, settled.attemptId], reason: "completed", outcome: "reclaimed" }]);
  // Never again.
  await sweepBenchClearing(w.deps);
  expect(w.reclaimed).toHaveLength(1);
});

test("revert-proof: a card with an attempt in progress is never cleared, and the board is not even read", async () => {
  const w = world(() => card("completed"), [{ attempts: [attempt(), attempt({ phase: "submission_pending" })] }]);
  expect((await sweepBenchClearing(w.deps))[0]?.outcome).toBe("unsettled");
  expect(w.reclaimed).toEqual([]);
  expect(w.reads).toEqual([]);
});

test("--keep-bench: the hub never clears that stage's benches, and does not read the card", async () => {
  const w = world(() => card("completed"), [{ attempts: [attempt()] }], { keepBench: async () => true });
  expect((await sweepBenchClearing(w.deps))[0]?.outcome).toBe("kept");
  expect(w.reclaimed).toEqual([]);
  expect(w.reads).toEqual([]);
});

// ─── a remote bench stage (the agent works in the bench from its own node) ───────────────────────

test("clearing skips a card whose attempt is working", async () => {
  // Attached, working, finishing: the bench is the agent's workspace. Even a card the board says is done keeps it.
  for (const phase of ["attach_pending", "working", "finish_pending"]) {
    const w = world(() => card("completed"), [{ attempts: [attempt(), attempt({ phase })] }]);
    expect((await sweepBenchClearing(w.deps))[0]?.outcome).toBe("unsettled");
    expect(w.reclaimed).toEqual([]);
    expect(w.reads).toEqual([]);
  }
});

test("clearing after a settled remote attempt follows keep_bench", async () => {
  // Settled (reported), its stage keeping benches: never cleared, the card never read.
  const kept = world(() => card("completed"), [{ attempts: [attempt({ phase: "reported" })] }], { keepBench: async () => true });
  expect((await sweepBenchClearing(kept.deps))[0]?.outcome).toBe("kept");
  expect(kept.reclaimed).toEqual([]);
  // Not kept: cleared on the bench host's node exactly as a one-shot attempt's, once the card is done.
  const a = attempt({ phase: "reported", nodeId: "node_bench" });
  const cleared = world(() => card("completed"), [{ attempts: [a] }]);
  expect(await sweepBenchClearing(cleared.deps)).toEqual([{ cardId: "card_1", outcome: "cleared", reason: "completed" }]);
  expect(cleared.reclaimed).toEqual([{ nodeId: "node_bench", tenantId: "fleet_t", boardId: "brd_b", stationId: "stn_s", cardId: "card_1",
    reason: "completed" }]);
  // Still on the board: warm, as for one-shot.
  const warm = world(() => card("submitted"), [{ attempts: [attempt({ phase: "reported" })] }]);
  expect((await sweepBenchClearing(warm.deps))[0]?.outcome).toBe("warm");
});

test("a card that used two nodes is cleared on both; a node whose stage keeps benches is left, and its attempts stay", async () => {
  const onA = attempt({ nodeId: "node_a" }), onB = attempt({ nodeId: "node_b" });
  const both = world(() => card("completed"), [{ attempts: [onA, onB] }]);
  await sweepBenchClearing(both.deps);
  expect(both.reclaimed.map((t) => t.nodeId).toSorted()).toEqual(["node_a", "node_b"]);
  const keepsB = world(() => card("completed"), [{ attempts: [onA, onB] }], { keepBench: async (a) => a.nodeId === "node_b" });
  await sweepBenchClearing(keepsB.deps);
  expect(keepsB.reclaimed.map((t) => t.nodeId)).toEqual(["node_a"]);
  expect(keepsB.recorded).toEqual([{ attemptIds: [onA.attemptId], reason: "completed", outcome: "reclaimed" }]);
});

test("a failed or refused reclaim only logs and records nothing; the next sweep asks again", async () => {
  for (const outcome of ["failed", "refused"] as ReclaimOutcome[]) {
    const w = world(() => card("completed"), [{ attempts: [attempt()] }]);
    w.deps.reclaim = async (target, reason) => { w.reclaimed.push({ ...target, reason }); return outcome; };
    expect((await sweepBenchClearing(w.deps))[0]?.outcome).toBe("retry");
    await sweepBenchClearing(w.deps);
    expect(w.reclaimed).toHaveLength(2);
    expect(w.recorded).toEqual([]);
  }
});

test("a dormant card no node would clear for 30 days is recorded abandoned, left to SuperBench's idle sweep", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const a = attempt({ updatedAtMs: NOW - ABANDON_AFTER_MS - HOUR });
    const w = world(() => ({ kind: "unknown" }), [{ attempts: [a] }], { reclaim: async () => "failed" });
    expect((await sweepBenchClearing(w.deps))[0]?.outcome).toBe("abandoned");
    expect(w.recorded).toEqual([{ attemptIds: [a.attemptId], reason: "dormant", outcome: "abandoned" }]);
  } finally { warn.mockRestore(); }
});

test("a sweep reads at most its limit of cards, oldest first, and a failing ledger or card never throws", async () => {
  const cards = [3, 1, 2].map((n) => ({ attempts: [attempt({ cardId: `card_${n}`, updatedAtMs: NOW - n * HOUR })] }));
  const w = world(() => card("working"), cards);
  await sweepBenchClearing(w.deps, 2);
  expect(w.reads).toEqual(["card_3", "card_2"]);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await sweepBenchClearing({ ...w.deps, cards: async () => { throw new Error("db down"); } })).toEqual([]);
    expect(await sweepBenchClearing({ ...w.deps, readCard: async () => { throw new Error("boom"); } })).toEqual([]);
  } finally { warn.mockRestore(); }
});

// ─── reading the card, and the setting ──────────────────────────────────────

test("the run view is read as the card as it is now; a view of another run or card is no answer", () => {
  const view = { run: { runId: "run_1", cardId: "card_1" }, card: { id: "card_1", state: "completed", archivedAt: null, updatedAt: "2026-11-24T11:00:00.000Z" } };
  expect(cardReadFromView(view, "run_1", "card_1")).toEqual({ kind: "card", state: "completed", archived: false, updatedAtMs: Date.parse("2026-11-24T11:00:00.000Z") });
  expect(cardReadFromView({ ...view, card: { ...view.card, archivedAt: "2026-11-24T11:00:00.000Z" } }, "run_1", "card_1")).toMatchObject({ archived: true });
  expect(cardReadFromView(view, "run_2", "card_1")).toEqual({ kind: "unknown" });
  expect(cardReadFromView({ ...view, card: { ...view.card, id: "card_2" } }, "run_1", "card_1")).toEqual({ kind: "unknown" });
  expect(cardReadFromView({}, "run_1", "card_1")).toEqual({ kind: "unknown" });
});

test("only the board's exact 404s mean the card is gone", () => {
  expect(cardReadFromError(new SuperpipelineApiError(404, "/p", "RUN_NOT_FOUND", "x"))).toEqual({ kind: "gone", code: "RUN_NOT_FOUND" });
  expect(cardReadFromError(new SuperpipelineApiError(404, "/p", "CARD_NOT_FOUND", "x"))).toEqual({ kind: "gone", code: "CARD_NOT_FOUND" });
  for (const error of [new SuperpipelineApiError(404, "/p", null, "x"), new SuperpipelineApiError(403, "/p", "NOT_RUN_OWNER", "x"),
    new SuperpipelineApiError(500, "/p", null, "x"), new Error("timeout")]) expect(cardReadFromError(error)).toEqual({ kind: "unknown" });
});

test("clearingReason: a last stage with work still to do is not terminal", () => {
  expect(clearingReason(card("submitted"), NOW, NOW, DORMANT)).toBeUndefined();
  expect(clearingReason(card("auth-required"), NOW, NOW, DORMANT)).toBeUndefined();
});

test("BENCH_DORMANT_AFTER_HOURS: whole hours, 0 off, anything else the default", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(dormantAfterMs(undefined)).toBe(72 * HOUR);
    expect(dormantAfterMs("24")).toBe(24 * HOUR);
    expect(dormantAfterMs("0")).toBe(0);
    for (const bad of ["-1", "1.5", "ten", "9000"]) expect(dormantAfterMs(bad)).toBe(72 * HOUR);
  } finally { warn.mockRestore(); }
});

// ─── what the node is asked ─────────────────────────────────────────────────

function reclaimFakes(over: Partial<ReclaimDeps> & { reply?: unknown; ok?: boolean } = {}) {
  const sent: Array<{ nodeId: string; verb: string; params: unknown }> = [];
  const d: ReclaimDeps = {
    online: () => true,
    request: async (nodeId, verb, params) => {
      sent.push({ nodeId, verb, params });
      return over.ok === false ? { ok: false, error: "timeout" } : { ok: true, data: over.reply ?? { state: "reclaimed", bench_id: "b" } };
    },
    ...over,
  };
  return { d, sent };
}
const target: ReclaimTarget = { nodeId: "node_a", tenantId: "fleet_t", boardId: "brd_b", stationId: "stn_s", cardId: "card_1" };

test("the node is asked to reclaim the card's bench by its own selector and card", async () => {
  const { d, sent } = reclaimFakes();
  expect(await reclaimCardBench(target, "completed", d)).toBe("reclaimed");
  expect(sent).toEqual([{ nodeId: "node_a", verb: "bench.reclaim",
    params: { tenant_id: "fleet_t", board_id: "brd_b", station_id: "stn_s", card_id: "card_1" } }]);
  expect(await reclaimCardBench(target, "completed", reclaimFakes({ reply: { state: "absent" } }).d)).toBe("absent");
});

test("a refusal, a timeout, an offline node or a bad reply only logs; nothing throws", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const info = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await reclaimCardBench(target, "dormant", reclaimFakes({ reply: { state: "refused", code: "lease_held" } }).d)).toBe("refused");
    expect(await reclaimCardBench(target, "dormant", reclaimFakes({ ok: false }).d)).toBe("failed");
    expect(await reclaimCardBench(target, "dormant", reclaimFakes({ reply: { state: "gone" } }).d)).toBe("failed");
    const offline = reclaimFakes({ online: () => false });
    expect(await reclaimCardBench(target, "dormant", offline.d)).toBe("failed");
    expect(offline.sent).toEqual([]);
    expect(await reclaimCardBench(target, "dormant", reclaimFakes({ request: async () => { throw new Error("broker down"); } }).d)).toBe("failed");
  } finally { warn.mockRestore(); info.mockRestore(); }
});
