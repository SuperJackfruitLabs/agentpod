import { describe, expect, test } from "bun:test";
import { serveBoardRead, boardReadsOf } from "./salaam-board-reads";

// Operator ruling 2026-10-28 (option iii): the hub serves an agent's board reads with its own
// clients, scoped to the run's own card and board. No credential reaches the station.
const run = { runId: "run_abc12345", cardId: "card_0123456789abcdef", boardId: "brd_0123456789abcdef" };
const prn = "prn_" + "a".repeat(20);
function deps(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const sp = {
    context: async (id: string) => (calls.push("context:" + id), { run: { runId: id, cardId: run.cardId }, card: { id: run.cardId, title: "T" }, handoff: null }),
    attempts: async (id: string) => (calls.push("attempts:" + id), { attempts: [{ runId: id, outcome: "completed" }] }),
  };
  const lib = {
    asAgent: (p: string) => ({
      request: async (method: string, path: string, init?: { json?: unknown }) => {
        calls.push(`${p} ${method} ${path} ${JSON.stringify(init?.json ?? null)}`);
        if (path === "/api/v1/search") return Response.json({ results: [{ id: "itm_0123456789abcdef", title: "Prior" }] });
        if (path === "/api/v1/library/itm_0123456789abcdef")
          return Response.json({ item: { id: "itm_0123456789abcdef", provenance: { board: run.boardId } }, text: "body" });
        if (path === "/api/v1/library/itm_fedcba9876543210")
          return Response.json({ item: { id: "itm_fedcba9876543210", provenance: { board: "brd_ffffffffffffffff" } }, text: "secret" });
        return new Response("{}", { status: 404 });
      },
    }),
  };
  return { calls, o: { run, agentPrincipal: prn, sp, library: lib as never, ...over } };
}

describe("serving a board read", () => {
  test("card and attempts read the run's own card, and nothing names another", async () => {
    const d = deps();
    const card = await serveBoardRead({ ...d.o, read: { id: "r1", action: "card", args: {} } } as never);
    expect(card).toMatchObject({ read_id: "r1", ok: true });
    expect(JSON.parse((card as { text: string }).text).card.id).toBe(run.cardId);
    const at = await serveBoardRead({ ...d.o, read: { id: "r2", action: "attempts", args: {} } } as never);
    expect(at).toMatchObject({ ok: true });
    expect(d.calls).toEqual(["context:" + run.runId, "attempts:" + run.runId]);
    // A read that tries to name a card or board is refused before anything is called.
    for (const args of [{ card_id: "card_ffffffffffffffff" }, { board: "brd_ffffffffffffffff" }])
      expect(await serveBoardRead({ ...d.o, read: { id: "r3", action: "card", args } } as never)).toMatchObject({ ok: false });
    expect(d.calls).toHaveLength(2);
  });
  test("a run context for another card is refused, not shown", async () => {
    const d = deps();
    d.o.sp.context = async () => ({ run: { runId: run.runId, cardId: "card_ffffffffffffffff" }, card: { id: "card_ffffffffffffffff" }, handoff: null }) as never;
    expect(await serveBoardRead({ ...d.o, read: { id: "r1", action: "card", args: {} } } as never)).toMatchObject({ ok: false });
  });
  test("library search is filtered to this board, as the agent", async () => {
    const d = deps();
    const r = await serveBoardRead({ ...d.o, read: { id: "r1", action: "library_search", args: { query: "gateway" } } } as never);
    expect(r).toMatchObject({ ok: true });
    expect(d.calls).toEqual([`${prn} POST /api/v1/search {"query":"gateway","board":"${run.boardId}","limit":10}`]);
  });
  test("a library item from another board is refused; one from this board is shown", async () => {
    const d = deps();
    expect(await serveBoardRead({ ...d.o, read: { id: "r1", action: "library_get", args: { item_id: "itm_0123456789abcdef" } } } as never)).toMatchObject({ ok: true });
    const other = await serveBoardRead({ ...d.o, read: { id: "r2", action: "library_get", args: { item_id: "itm_fedcba9876543210" } } } as never);
    expect(other).toMatchObject({ ok: false });
    expect(JSON.stringify(other)).not.toContain("secret");
  });
  test("an unknown action, or no library configured, answers in plain words", async () => {
    const d = deps({ library: null });
    expect(await serveBoardRead({ ...d.o, read: { id: "r1", action: "write", args: {} } } as never)).toMatchObject({ ok: false });
    expect(await serveBoardRead({ ...d.o, read: { id: "r2", action: "library_search", args: { query: "x" } } } as never)).toEqual({
      read_id: "r2",
      ok: false,
      error: "The library is not available here.",
    });
  });
  test("work status carries at most a few well-formed reads; anything else is ignored", () => {
    expect(boardReadsOf({ board_reads: [{ id: "r1", action: "card", args: {} }, { id: 5 }] })).toEqual([{ id: "r1", action: "card", args: {} }]);
    expect(boardReadsOf({})).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: "r" + i, action: "card", args: {} }));
    expect(boardReadsOf({ board_reads: many })).toHaveLength(8);
  });
});
