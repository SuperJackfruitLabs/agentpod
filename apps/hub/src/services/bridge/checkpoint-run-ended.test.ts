/**
 * What counts as the board definitively ending a checkpoint attempt's run, and what does not.
 * The views are shaped as SuperPipeline's GET runs/:runId returns them (board/run-history.ts
 * getRunContext), after the board's own transitions: a human move (board/moves.ts moveCard) leaves
 * the run `working` and clears the card's currentRunId; fail, release, reclaim and completion end
 * the run; deleting the card deletes its runs.
 */
import { expect, test } from "bun:test";
import claimFixture from "./checkpoint-contract/claim.fixture.json";
import { CheckpointClaimRefused, checkpointPolicyDigest, parsePendingCheckpointClaim, validateCheckpointContext } from "./checkpoint-claim";
import { readRunEnded, runEndedFromError, runEndedFromView } from "./checkpoint-run-ended";
import { boardErrorBody, BOARD_RUN_CODES } from "./checkpoint-agent-client";
import { SuperpipelineApiError, SuperpipelineClient } from "./superpipeline";
import { endedRunView as endedRunViewOf, movedRunView as movedRunViewOf, runView } from "./checkpoint-run-view.test-fixture";

const claim = parsePendingCheckpointClaim({ ...claimFixture.pending,
  policyDigest: checkpointPolicyDigest(claimFixture.pending.policy) });
const liveRunView = () => runView(claim);
const movedRunView = () => movedRunViewOf(claim);
const endedRunView = (outcome: string) => endedRunViewOf(claim, outcome);

test("a live, bound run on its own card is not ended", () => {
  expect(runEndedFromView(liveRunView(), claim)).toBeUndefined();
  // And it is the context the checkpoint path accepts.
  expect(() => validateCheckpointContext(liveRunView(), claim, claim.boardId, claim.runId)).not.toThrow();
});

test("a card moved off the stage unbinds the run: the live sequence's `context` refusal is run.unbound", () => {
  const moved = movedRunView();
  // This is the view that made every current-decision refuse `context` on staging.
  expect(() => validateCheckpointContext(moved, claim, claim.boardId, claim.runId)).toThrow(CheckpointClaimRefused);
  expect(runEndedFromView(moved, claim)).toEqual({ reason: "run.unbound", board: { status: "working", outcome: null,
    endedAt: null, leaseEpoch: claim.leaseEpoch, cardRunId: null, cardStage: "review" } });
  // A card claimed again carries a NEW run id; the old run stays unbound.
  const reclaimed = { ...moved, card: { ...moved.card, currentStageKey: claim.stageKey, currentRunId: "run_newer", state: "working" } };
  expect(runEndedFromView(reclaimed, claim)?.reason).toBe("run.unbound");
});

test.each(["completed", "crashed", "released", "reclaimed", "blocked", "submitted"])("a run that ended %s is run.ended", (outcome) => {
  expect(runEndedFromView(endedRunView(outcome), claim)).toMatchObject({ reason: "run.ended", board: { status: "ended", outcome } });
});

test("another lease epoch is run.epoch", () => {
  const live = liveRunView();
  expect(runEndedFromView({ ...live, run: { ...live.run, leaseEpoch: claim.leaseEpoch + 1 } }, claim)?.reason).toBe("run.epoch");
});

test("an answer about another run or card, or one that does not parse, proves nothing", () => {
  const live = liveRunView();
  expect(runEndedFromView({ ...endedRunView("crashed"), run: { ...endedRunView("crashed").run, runId: "run_other" } }, claim)).toBeUndefined();
  expect(runEndedFromView({ ...endedRunView("crashed"), run: { ...endedRunView("crashed").run, cardId: "card_other" } }, claim)).toBeUndefined();
  expect(runEndedFromView({ ...live, card: { ...live.card, id: "card_other", currentRunId: null } }, claim)).toBeUndefined();
  for (const broken of [{}, null, "ended", { run: { ...live.run, status: 7 }, card: live.card }, { run: live.run }])
    expect(runEndedFromView(broken, claim)).toBeUndefined();
});

const error = (status: number, code: string | null) => new SuperpipelineApiError(status, "/v1/boards/b/runs/r", code, "refused");
test("only the board's exact ending refusals count", () => {
  expect(runEndedFromError(error(409, "STALE_LEASE"))?.reason).toBe("lease.stale");
  expect(runEndedFromError(error(404, "RUN_NOT_FOUND"))?.reason).toBe("run.not_found");
  expect(runEndedFromError(error(404, "CARD_NOT_FOUND"))?.reason).toBe("card.not_found");
  // Transient, someone else's, or not the board's own word: never an ending.
  for (const [status, code] of [[502, null], [503, "STALE_LEASE"], [403, "NOT_RUN_OWNER"], [404, null], [404, "NOT_INITIALIZED"],
    [409, "GATE_NOT_PENDING"], [409, null], [401, null]] as const)
    expect(runEndedFromError(error(status, code))).toBeUndefined();
  expect(runEndedFromError(Object.assign(new Error("timed out"), { name: "TimeoutError" }))).toBeUndefined();
  expect(runEndedFromError(new CheckpointClaimRefused("context"))).toBeUndefined();
});

test("readRunEnded reads the run view, and a board that cannot answer is not an answer", async () => {
  const client = (answer: () => { status: number; body: unknown }) => new SuperpipelineClient({ baseUrl: "https://board.test",
    boardId: claim.boardId, token: "spa_fixture", fetch: async (url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toBe(`https://board.test/v1/boards/${claim.boardId}/runs/${claim.runId}`);
      const { status, body } = answer();
      return { status, ok: status < 300, json: async () => body };
    } });
  expect((await readRunEnded(client(() => ({ status: 200, body: movedRunView() })), claim))?.reason).toBe("run.unbound");
  expect(await readRunEnded(client(() => ({ status: 200, body: liveRunView() })), claim)).toBeUndefined();
  expect(await readRunEnded(client(() => ({ status: 502, body: {} })), claim)).toBeUndefined();
  expect((await readRunEnded(client(() => ({ status: 404, body: { error: { ok: false, code: "RUN_NOT_FOUND", message: "gone" } } })), claim))
    ?.reason).toBe("run.not_found");
  const thrown = new SuperpipelineClient({ baseUrl: "https://board.test", boardId: claim.boardId, token: "spa_fixture",
    fetch: async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); } });
  expect(await readRunEnded(thrown, claim)).toBeUndefined();
});

// The checkpoint client's bounded fetch used to drop the board's error body whole, so no
// STALE_LEASE ever reached a held failure (`lease_ended`) and no RUN_NOT_FOUND reached this path.
test("the checkpoint client keeps a closed board code from an error body, and nothing else", () => {
  expect([...BOARD_RUN_CODES].toSorted()).toEqual(["CARD_NOT_FOUND", "NOT_RUN_OWNER", "RUN_NOT_FOUND", "STALE_LEASE"]);
  for (const code of BOARD_RUN_CODES)
    expect(boardErrorBody(JSON.stringify({ error: { ok: false, code, message: "secret detail spa_abc" } }))).toEqual({ error: { code } });
  for (const raw of [JSON.stringify({ error: { code: "GATE_NOT_PENDING", message: "x" } }), JSON.stringify({ error: "STALE_LEASE" }),
    JSON.stringify({ error: { code: 409 } }), "not json", "", "null"])
    expect(boardErrorBody(raw)).toEqual({ error: "CHECKPOINT_REQUEST_REFUSED" });
});
