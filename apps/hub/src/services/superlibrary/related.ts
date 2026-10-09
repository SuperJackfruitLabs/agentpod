/**
 * Superlibrary's related prior work for a claimed card, for the prompt's "Related prior work"
 * section (Superlibrary spec §10).
 *
 * Everything here is optional to the claim. Superlibrary unconfigured, the board switched off, a
 * station with no agent principal, or any failure or lateness at all: the answer is `undefined`,
 * the section is left out and the claim goes ahead. The whole call is held to one deadline,
 * token mints included, because the caller's own `timeoutMs` only starts once the token is in
 * hand and each mint may take seconds of its own.
 */
import { eq } from "drizzle-orm";
import { CardPromptRelated } from "@agentpod/contract";

import { db } from "../../db/drizzle";
import { bridgeBoardSettings } from "../../db/schema/bridge";
import { tenantScope } from "../../db/tenant-scope";
import { createLogger } from "../../utils/logger";
import { superlibraryClient, type SuperlibraryClient } from "./client";

/** The most a claim waits for related work, end to end. */
export const RELATED_TIMEOUT_MS = 2500;

/** Is the related section on for this board? On when the board has no settings row. */
export async function relatedWorkEnabled(tenantId: string, boardId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: bridgeBoardSettings.relatedWork })
    .from(bridgeBoardSettings)
    .where(tenantScope(bridgeBoardSettings, tenantId, eq(bridgeBoardSettings.boardId, boardId)))
    .limit(1);
  return row ? row.on : true;
}

/**
 * `principal` may be a lookup rather than a value: it is then awaited only once Superlibrary is
 * configured and the board's switch is on, so a claim that will not fetch related work never
 * waits for it. The lookup runs inside the deadline.
 */
export type RelatedWorkInput = {
  tenantId: string;
  boardId: string;
  cardId: string;
  principal: string | null | (() => Promise<string | null>);
};
type Log = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

/** One item of `POST /api/v1/related`, as far as the prompt reads it. */
interface RelatedItem {
  itemId?: unknown;
  kind?: unknown;
  title?: unknown;
  outcome?: unknown;
  url?: unknown;
  snippet?: unknown;
  wrapped?: unknown;
  provenance?: { board?: unknown; card?: unknown; sourceKind?: unknown } | null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Superlibrary's own stage timings (its Server-Timing), names and numbers only. */
export function stageTimings(h: string | null): string {
  return (h ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9]+;(dur=\d+|desc="\d+")$/.test(s))
    .join(", ")
    .slice(0, 400);
}

/** Gap S4: mint the agent's token while the claim reads its run context, so the related call finds it cached. */
export function createPrefetchRelatedWork(deps: {
  client: () => SuperlibraryClient | null;
  enabled: (tenantId: string, boardId: string) => Promise<boolean>;
}) {
  return function prefetchRelatedWork(i: RelatedWorkInput): void {
    const lib = deps.client();
    if (!lib || i.principal === null) return;
    void (async () => {
      if (!(await deps.enabled(i.tenantId, i.boardId))) return;
      const principal = typeof i.principal === "function" ? await i.principal() : i.principal;
      if (principal) await lib.warmAgent(principal);
    })().catch(() => {});
  };
}
export const prefetchRelatedWork = createPrefetchRelatedWork({ client: superlibraryClient, enabled: relatedWorkEnabled });

export function createFetchRelatedWork(deps: {
  client: () => SuperlibraryClient | null;
  enabled: (tenantId: string, boardId: string) => Promise<boolean>;
  log?: Log;
  /** The end-to-end deadline. A test seam; production is `RELATED_TIMEOUT_MS`. */
  deadlineMs?: number;
}) {
  const log = deps.log ?? createLogger("related-work");
  const deadline = deps.deadlineMs ?? RELATED_TIMEOUT_MS;

  async function attempt(lib: SuperlibraryClient, i: RelatedWorkInput): Promise<{ items: CardPromptRelated[]; serverTiming: string } | null> {
    if (!(await deps.enabled(i.tenantId, i.boardId))) return null;
    const principal = typeof i.principal === "function" ? await i.principal() : i.principal;
    if (!principal) return null;
    // The agent's own token: the section shows what this agent's roster may see, and nothing more.
    const res = await lib
      .asAgent(principal)
      .request("POST", "/api/v1/related", { json: { cardId: i.cardId }, timeoutMs: RELATED_TIMEOUT_MS });
    if (!res.ok) throw new Error(`Superlibrary answered ${res.status}`);
    const raw = await res.text();
    let body: { items?: unknown };
    try {
      body = JSON.parse(raw) as { items?: unknown };
    } catch {
      // A fixed message: a parser's own error can quote the body, and bodies are never logged.
      throw new Error("Superlibrary answered with a body that is not JSON");
    }
    if (!body || !Array.isArray(body.items)) throw new Error("Superlibrary answered without an items list");
    const out: CardPromptRelated[] = [];
    for (const r of body.items as RelatedItem[]) {
      const p = r?.provenance ?? {};
      const parsed = CardPromptRelated.safeParse({
        itemId: r?.itemId,
        kind: r?.kind,
        title: r?.title,
        outcome: r?.outcome,
        url: r?.url,
        ...(str(p.board) ? { board: p.board } : {}),
        ...(str(p.card) ? { card: p.card } : {}),
        ...(str(p.sourceKind) ? { source: p.sourceKind } : {}),
        text: (typeof r?.wrapped === "string" ? textOf(r.wrapped) : null) ?? (typeof r?.snippet === "string" ? r.snippet : ""),
      });
      // One malformed item is dropped rather than failing the prompt's parse, and with it the claim.
      if (parsed.success) out.push(parsed.data);
    }
    return { items: out, serverTiming: stageTimings(res.headers.get("server-timing")) };
  }

  return async function fetchRelatedWork(i: RelatedWorkInput): Promise<CardPromptRelated[] | undefined> {
    const lib = deps.client();
    if (!lib || i.principal === null) return undefined;
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((done) => {
      timer = setTimeout(() => done("late"), deadline);
    });
    try {
      const r = await Promise.race([attempt(lib, i), late]);
      if (r === "late") throw new Error(`no answer within ${deadline} ms`);
      if (r === null) return undefined;
      const { items, serverTiming } = r;
      // One line per dispatch, so an operator can see from the journal that the section went out.
      // Ids, boards and outcomes only: never a title, a body or a token.
      log.info("related prior work attached", {
        cardId: i.cardId,
        boardId: i.boardId,
        count: items.length,
        elapsedMs: Date.now() - t0,
        serverTiming,
        items: items.map((x) => ({ itemId: x.itemId, board: x.board ?? null, outcome: x.outcome })),
      });
      return items;
    } catch (err) {
      // Spec §10: if Superlibrary is unreachable, the section is left out and the claim goes ahead.
      const error = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "unknown error";
      log.warn("related prior work skipped", { cardId: i.cardId, boardId: i.boardId, elapsedMs: Date.now() - t0, error });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The body Superlibrary capped, recovered from its wrapped block (the prompt re-wraps it the same way). */
function textOf(wrapped: string): string | null {
  const m = wrapped.match(/^<library-item [^>]*>\ntitle: [^\n]*\n([\s\S]*)\n<\/library-item>$/);
  return m ? m[1]! : null;
}

export const fetchRelatedWork = createFetchRelatedWork({ client: superlibraryClient, enabled: relatedWorkEnabled });
