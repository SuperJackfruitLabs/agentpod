/**
 * Hand-rolled kaambaan agent client.
 *
 * Deliberately NOT @kaambaan/agent-sdk: its AgentActivity interface exposes only
 * {type, body, action, ephemeral, signal} and omits usage, parameter, result and
 * signalMetadata — the exact fields RQ1, RQ2 and RQ5 depend on.
 *
 * Verified paths (2026-08-11, kaambaan @ 573a9ba, local wrangler dev):
 *   POST /v1/boards/{board}/claims                        agent bearer
 *   POST /v1/boards/{board}/runs/{run}/{action}           agent bearer
 *   GET  /v1/boards/{board}                               dev header (snapshot)
 */

export interface Work {
  runId: string;
  leaseEpoch: number;
  card: { id: string; title: string; currentStageKey: string };
  stage: { key: string; name: string };
  handoff: unknown;
}

export interface Activity {
  type: "thought" | "action" | "response" | "elicitation" | "error";
  body?: string;
  action?: string;
  parameter?: unknown;
  result?: unknown;
  ephemeral?: boolean;
  signal?: string;
  signalMetadata?: unknown;
  usage?: { model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number };
}

/** One card as it appears in the board snapshot. */
export interface CardRow {
  id: string;
  title: string;
  currentStageKey: string;
  state: string;
  delegateAgentId: string | null;
  attemptCount: number;
  costUsd: number;
  overBudget: boolean;
}

export interface BoardSnapshot {
  boardId: string;
  stages: unknown[];
  cards: CardRow[];
  gates: unknown[];
  usage: unknown;
}

export class Kaambaan {
  constructor(
    private base: string,
    private boardId: string,
    private token: string,
    private tenantId: string,
  ) {}

  private async post(path: string, body: unknown): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error(`kaambaan ${path} → ${res.status} ${await res.clone().text()}`);
    return res;
  }

  async claim(): Promise<Work | null> {
    const res = await this.post(`/v1/boards/${this.boardId}/claims`, {});
    if (!res.ok) return null;
    const b = (await res.json()) as any;
    if (!b?.claimed) return null;
    return {
      runId: b.runId,
      leaseEpoch: b.leaseEpoch,
      card: b.card,
      stage: b.stage,
      handoff: b.handoff ?? null,
    };
  }

  private run(w: Work, action: string, extra: Record<string, unknown> = {}) {
    return this.post(`/v1/boards/${this.boardId}/runs/${w.runId}/${action}`, {
      leaseEpoch: w.leaseEpoch,
      ...extra,
    });
  }

  heartbeat = (w: Work) => this.run(w, "heartbeat");
  activity = (w: Work, a: Activity) => this.run(w, "activities", { ...a });
  complete = (w: Work, handoff?: unknown) => this.run(w, "complete", { handoff });
  fail = (w: Work, reason: string) => this.run(w, "fail", { reason });

  /**
   * Whole-board snapshot. There is no card-read endpoint — `/v1/boards/:id/cards/:card`
   * exists but rejects GET (405), and `/v1/boards/:id/cards` is POST-only. The board
   * snapshot is the only read surface, and it carries `state`, `attemptCount` and
   * `costUsd` per card, which is what RQ2 and RQ4 need anyway.
   */
  async board(): Promise<BoardSnapshot> {
    const res = await fetch(`${this.base}/v1/boards/${this.boardId}`, {
      headers: { "X-Tenant-Id": this.tenantId },
    });
    if (!res.ok) throw new Error(`board read → ${res.status} ${await res.text()}`);
    return (await res.json()) as BoardSnapshot;
  }

  async card(cardId: string): Promise<CardRow | undefined> {
    return (await this.board()).cards.find((c) => c.id === cardId);
  }
}
