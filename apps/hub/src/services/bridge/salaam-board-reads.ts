import type { SuperlibraryClient } from "../superlibrary/client";
import type { SuperpipelineClient } from "./superpipeline";

/**
 * Board reads (operator ruling 2026-10-28, option iii). A Salaam agent reads its own card and its
 * card's runs, and searches or opens library items, while it works. The hub serves every read with
 * its own clients: the board client it already holds for this run, and the agent's own
 * SuperLibrary token, which never leaves the hub. No credential reaches the station.
 *
 * Scope is the hub's, never the agent's: a read names no card or board. Card and attempts are the
 * run's own; library search is filtered to the run's board; a library item from another board is
 * refused. Read-only: nothing here changes the board or the library.
 */
export type BoardReadAction = "card" | "attempts" | "library_search" | "library_get";
export interface BoardReadRequest {
  id: string;
  action: string;
  args: Record<string, unknown>;
}
export type BoardReadAnswer = { read_id: string; ok: true; text: string } | { read_id: string; ok: false; error: string };

/** The most one answer carries back (Salaam bounds it at 256 KiB). */
const MAX_TEXT = 200 * 1024;
const ITEM = /^itm_[0-9a-f]{16}$/;

/** Well-formed reads from a work status, at most eight; anything else is ignored. */
export function boardReadsOf(status: unknown): BoardReadRequest[] {
  const list = (status as { board_reads?: unknown } | null)?.board_reads;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (r): r is BoardReadRequest =>
        !!r &&
        typeof r === "object" &&
        typeof (r as BoardReadRequest).id === "string" &&
        (r as BoardReadRequest).id.length <= 64 &&
        typeof (r as BoardReadRequest).action === "string" &&
        !!(r as BoardReadRequest).args &&
        typeof (r as BoardReadRequest).args === "object",
    )
    .slice(0, 8);
}

const refuse = (id: string, error: string): BoardReadAnswer => ({ read_id: id, ok: false, error });
const show = (id: string, value: unknown): BoardReadAnswer => {
  const text = JSON.stringify(value);
  return { read_id: id, ok: true, text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text };
};

export async function serveBoardRead(o: {
  read: BoardReadRequest;
  run: { runId: string; cardId: string; boardId: string };
  agentPrincipal: string;
  sp: Pick<SuperpipelineClient, "context" | "attempts">;
  library: SuperlibraryClient | null;
}): Promise<BoardReadAnswer> {
  const { read, run } = o;
  const keys = Object.keys(read.args).sort().join(",");
  try {
    if (read.action === "card" || read.action === "attempts") {
      if (keys !== "") return refuse(read.id, "A board read is always this run's own card; it names no card or board.");
      if (read.action === "attempts") return show(read.id, await o.sp.attempts(run.runId));
      const context = await o.sp.context(run.runId);
      if (context.run.cardId !== run.cardId || (context.card as { id?: string }).id !== run.cardId)
        return refuse(read.id, "That is not this run's card.");
      return show(read.id, { card: context.card, stage: (context as { stage?: unknown }).stage, handoff: context.handoff });
    }
    if (read.action === "library_search" || read.action === "library_get") {
      if (!o.library) return refuse(read.id, "The library is not available here.");
      const lib = o.library.asAgent(o.agentPrincipal);
      if (read.action === "library_search") {
        const q = read.args.query;
        if (keys !== "query" || typeof q !== "string" || !q.trim() || q.length > 500)
          return refuse(read.id, "A library search takes one query of up to 500 characters.");
        const res = await lib.request("POST", "/api/v1/search", { json: { query: q.trim(), board: run.boardId, limit: 10 } });
        if (!res.ok) return refuse(read.id, "The library search did not answer.");
        return show(read.id, await res.json());
      }
      const item = read.args.item_id;
      if (keys !== "item_id" || typeof item !== "string" || !ITEM.test(item))
        return refuse(read.id, "A library read takes one item id.");
      const res = await lib.request("GET", `/api/v1/library/${item}`);
      if (res.status === 404) return refuse(read.id, "That library item was not found.");
      if (!res.ok) return refuse(read.id, "The library did not answer.");
      const body = (await res.json()) as { item?: { provenance?: { board?: string } } };
      if (body.item?.provenance?.board !== run.boardId) return refuse(read.id, "That library item belongs to another board.");
      return show(read.id, body);
    }
    return refuse(read.id, "Board reads are card, attempts, library_search or library_get.");
  } catch {
    return refuse(read.id, "The board did not answer this read.");
  }
}

/**
 * One pass over a work status: serve each pending board read and send its answer to Salaam as
 * `salaam.work-read` `{ binding, answer }`. The strict loop calls this with the broker; the
 * contract test calls it with a recorder, against Salaam's own status and answer fixture.
 */
export async function serveSalaamBoardReads<B>(o: {
  status: unknown;
  binding: B;
  run: { runId: string; cardId: string; boardId: string };
  agentPrincipal: string;
  sp: Pick<SuperpipelineClient, "context" | "attempts">;
  library: SuperlibraryClient | null;
  send: (payload: { binding: B; answer: BoardReadAnswer }) => Promise<{ ok: boolean; error?: string }>;
  log?: (what: string, fields: Record<string, unknown>) => void;
}): Promise<void> {
  for (const read of boardReadsOf(o.status)) {
    const answer = await serveBoardRead({ read, run: o.run, agentPrincipal: o.agentPrincipal, sp: o.sp, library: o.library });
    o.log?.("board read", { run: o.run.runId, action: read.action, ok: answer.ok });
    const sent = await o.send({ binding: o.binding, answer });
    if (!sent.ok) o.log?.("board read not delivered", { run: o.run.runId, error: sent.error });
  }
}
