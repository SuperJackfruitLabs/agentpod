/**
 * A client for kaambaan's agent contract — the surface a `kbn_` token reaches,
 * and nothing else.
 *
 * ## Why this is not `@kaambaan/agent-sdk`
 *
 * The SDK now speaks `kbn_` bearer auth and gained `context(work)`, which is
 * what removed the spike's dev-header dependency, and this client deliberately
 * mirrors its method names and types so it is a drop-in the day the SDK becomes
 * consumable. It is not consumable today, for three reasons in descending order
 * of finality:
 *
 * 1. **It is not published.** `packages/agent-sdk/package.json` is
 *    `"private": true` with `"main": "./src/index.ts"`, and `@kaambaan/agent-sdk`
 *    is a 404 on npm. There is no way to depend on it from another repo short
 *    of vendoring the file — and vendoring an unversioned copy is worse than an
 *    honest reimplementation, because it looks like a dependency.
 * 2. **The suite has already decided against a shared package.** A published
 *    package couples two deploy pipelines with very different cadences;
 *    `fixtures/ecosystem-identity/` exists precisely so the two repos agree
 *    through a checked corpus instead. Adding the coupling here would contradict
 *    the mechanism this repo already runs in CI.
 * 3. **Its run verbs return the raw response.** `heartbeat`/`activity`/
 *    `complete` hand back an `HttpResponse` and never throw, so a 403 and a 409
 *    are equally easy to ignore — and telling those two apart is the whole
 *    reason requirement 2 exists. It also has no `submitForReview`, and its
 *    `AgentActivity` omits `parameter` and `result`, which is where a tool
 *    call's input and output have to go.
 *
 * ## The two failures this client refuses to blur
 *
 * kaambaan checks identity **before** the lease (board-do.ts:1746-1766) so that
 * these never collapse into one another:
 *
 * - **403 `NOT_RUN_OWNER`** — the run belongs to another agent. A bug in the
 *   caller. Retrying repeats the hijack.
 * - **409 `STALE_LEASE`** — the lease lapsed and the card has been re-queued.
 *   Stop working; someone else has it.
 *
 * Both are surfaced as `code` on the thrown error, and classified by code
 * rather than by status, because kaambaan answers 403 for
 * `SEPARATION_OF_DUTIES` and 409 for `GATE_NOT_PENDING` as well.
 */

import type { BoardActivity } from "./coalesce";

/** Injected so the client runs in a test with no network and no wrangler. */
export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

export interface KaambaanClientOptions {
  baseUrl: string;
  boardId: string;
  /** The agent's own credential. Decision 3: an agent's authority is its own. */
  token: string;
  fetch: Fetcher;
}

export interface ClaimedCard {
  id: string;
  title: string;
  spec?: unknown;
  currentStageKey?: string;
  state?: string;
  /** Increments on **claim**, not on reclaim (spike RQ4). */
  attemptCount?: number;
}

export interface ClaimedWork {
  runId: string;
  leaseEpoch: number;
  card: ClaimedCard;
  stage: { key: string; name: string } | null;
  handoff: unknown;
}

export interface RunReference {
  id: string;
  url: string;
  title: string | null;
  provider: string;
  sourceType: string;
}

/** `GET /v1/boards/:boardId/runs/:runId` — re-readable, no lease required. */
export interface RunContext {
  run: {
    runId: string;
    cardId: string;
    stageKey: string;
    leaseEpoch: number;
    status: string;
    outcome: string | null;
    startedAt: string;
    endedAt: string | null;
  };
  card: ClaimedCard;
  stage: { key: string; name: string } | null;
  handoff: unknown;
  references: RunReference[];
}

/** The lease a run verb is authorized by. */
export interface RunLease {
  runId: string;
  leaseEpoch: number;
}

/** A refusal from the board, carrying kaambaan's own error code when it sent one. */
export class KaambaanApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    /** kaambaan's `BoardErrorCode`, or null when the body carried none. */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "KaambaanApiError";
  }
}

/**
 * The lease lapsed: the card has been re-queued and may already be someone
 * else's. Stop work — and, because kaambaan fences its own state but nothing
 * fences the machine, end the ACP session too.
 */
export function isLeaseSuperseded(err: unknown): boolean {
  return err instanceof KaambaanApiError && err.code === "STALE_LEASE";
}

/**
 * The run belongs to another agent. Never a retry: the call was understood and
 * permanently refused, and repeating it is repeating the hijack.
 */
export function isForeignRun(err: unknown): boolean {
  return err instanceof KaambaanApiError && err.code === "NOT_RUN_OWNER";
}

/** kaambaan replies `{error: {ok:false, code, message}}`, or `{error: "…"}`. */
function readError(body: unknown): { code: string | null; message: string } {
  const e = (body as { error?: unknown } | null)?.error;
  if (typeof e === "string") return { code: null, message: e };
  if (e && typeof e === "object") {
    const o = e as { code?: unknown; message?: unknown };
    return {
      code: typeof o.code === "string" ? o.code : null,
      message: typeof o.message === "string" ? o.message : "",
    };
  }
  return { code: null, message: "" };
}

export class KaambaanClient {
  private readonly baseUrl: string;
  private readonly boardId: string;
  private readonly token: string;
  private readonly fetch: Fetcher;

  constructor(opts: KaambaanClientOptions) {
    if (!opts.token.startsWith("kbn_")) {
      throw new Error(
        'KaambaanClient: token must be a kaambaan agent token ("kbn_…"), minted via "Connect an agent"',
      );
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.boardId = opts.boardId;
    this.token = opts.token;
    this.fetch = opts.fetch;
  }

  private headers(): Record<string, string> {
    // Bearer only. The spike sent `X-Tenant-Id: tnt_dev` because no
    // agent-readable read existed; a deployed kaambaan rejects dev headers, so
    // sending one is a bug that surfaces only against production.
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` };
  }

  private async send(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.ok) return res.json();

    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // A non-JSON body is a proxy or a crash; the status is the whole story.
    }
    const { code, message } = readError(parsed);
    throw new KaambaanApiError(
      res.status,
      path,
      code,
      `${method} ${path} failed with ${res.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`,
    );
  }

  /**
   * Claim the next ready card, or null when there is none.
   *
   * A bare `{claimed:false}` is also what an over-budget board and an agent at
   * its concurrency cap return (board-do.ts:1301-1320). kaambaan does not say
   * which, so neither does this — inventing a reason we were not told is how a
   * paused board gets reported as an idle one.
   *
   * A refusal is an error, never "nothing available": a rejected token that
   * looked like an empty queue would poll forever and report healthy.
   */
  async claim(opts: { maxConcurrency?: number; profileKey?: string } = {}): Promise<ClaimedWork | null> {
    const body: Record<string, unknown> = {};
    if (opts.maxConcurrency !== undefined) body.maxConcurrency = opts.maxConcurrency;
    if (opts.profileKey !== undefined) body.profileKey = opts.profileKey;

    // No agentId, no capabilities: the token carries the agent's identity and
    // its registered capabilities, and a client-asserted identity is a request
    // to be treated as someone else.
    const res = (await this.send("POST", `/v1/boards/${this.boardId}/claims`, body)) as {
      claimed?: boolean;
      runId?: string;
      leaseEpoch?: number;
      card?: ClaimedCard;
      stage?: { key: string; name: string };
      handoff?: unknown;
    };

    if (!res.claimed || !res.runId || res.leaseEpoch === undefined || !res.card) return null;
    return {
      runId: res.runId,
      leaseEpoch: res.leaseEpoch,
      card: res.card,
      stage: res.stage ?? null,
      handoff: res.handoff ?? null,
    };
  }

  /**
   * Re-read a run this agent owns: the card, its stage, the upstream handoff
   * and the card's references. No lease required, so a finished run stays
   * readable — which is what lets the bridge check what a previous attempt was
   * asked to do before deciding to repeat it.
   */
  async context(runId: string): Promise<RunContext> {
    return (await this.send("GET", `/v1/boards/${this.boardId}/runs/${runId}`)) as RunContext;
  }

  private verb(lease: RunLease, action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    return this.send("POST", `/v1/boards/${this.boardId}/runs/${lease.runId}/${action}`, {
      leaseEpoch: lease.leaseEpoch,
      ...extra,
    });
  }

  heartbeat(lease: RunLease): Promise<unknown> {
    return this.verb(lease, "heartbeat");
  }

  /** Note the action is `activities`; kaambaan's RPC method is `postActivity`. */
  activity(lease: RunLease, activity: BoardActivity): Promise<unknown> {
    return this.verb(lease, "activities", { ...activity });
  }

  complete(lease: RunLease, handoff?: unknown): Promise<unknown> {
    return this.verb(lease, "complete", handoff === undefined ? {} : { handoff });
  }

  /** Action name `submit`; kaambaan's RPC method is `submitForReview`. */
  submitForReview(lease: RunLease, output?: unknown): Promise<unknown> {
    return this.verb(lease, "submit", output === undefined ? {} : { output });
  }

  block(lease: RunLease, reason: string): Promise<unknown> {
    return this.verb(lease, "block", { reason });
  }

  fail(lease: RunLease, reason: string): Promise<unknown> {
    return this.verb(lease, "fail", { reason });
  }

  release(lease: RunLease): Promise<unknown> {
    return this.verb(lease, "release");
  }
}
