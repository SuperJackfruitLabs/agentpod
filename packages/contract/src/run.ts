import { z } from "zod";

// ─── Run state ───────────────────────────────────────────────────────────────

/**
 * A2A's `TaskState`, adopted verbatim.
 *
 * Not our own vocabulary, deliberately. kaambaan's state machine is A2A-exact
 * (its `primitives.ts` notes `canceled` is spelled with one "l" to match), and
 * inventing a parallel enum here would mean a translation table between our
 * runs and the board's tasks — the exact drift §10 warns about, made worse by
 * spanning two repos.
 *
 * The bridge spike confirmed the mapping is free: an ACP permission request is
 * `input-required`, an expired harness credential is `auth-required`, and a
 * station that drops its gateway connection is reclaimed back to `submitted`.
 */
export const RunState = z.enum([
  "submitted",
  "working",
  "input-required",
  "auth-required",
  "completed",
  "rejected",
  "failed",
  "canceled",
]);
export type RunState = z.infer<typeof RunState>;

export const TERMINAL_RUN_STATES = ["completed", "rejected", "failed", "canceled"] as const;
export const INTERRUPTED_RUN_STATES = ["input-required", "auth-required"] as const;

export const isRunTerminal = (s: RunState): boolean =>
  (TERMINAL_RUN_STATES as readonly string[]).includes(s);
export const isRunInterrupted = (s: RunState): boolean =>
  (INTERRUPTED_RUN_STATES as readonly string[]).includes(s);

// ─── Run ─────────────────────────────────────────────────────────────────────

/**
 * One attempt on a station — the join key from §3.
 *
 * A run is a **prompt-turn**: it opens when a prompt is submitted to a session
 * and closes when the agent yields. A permission request does *not* close it;
 * blocking on approval is mid-attempt, and closing there would fragment one
 * piece of work into three runs and make any per-run accounting meaningless.
 *
 * `externalRunId` carries kaambaan's `runId` when the attempt came from a claim,
 * and is absent when it did not. We never mint a rival id: the board already has
 * one, and two id spaces for the same concept across two repos is the failure
 * §10 calls the highest-leverage ordering risk. The console must keep working
 * with no board attached at all, which is why it is optional rather than
 * required.
 */
export const Run = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  stationId: z.string().min(1),

  /** kaambaan's runId, when this attempt came from a claim. */
  externalRunId: z.string().min(1).optional(),
  /** Which orchestrator minted `externalRunId`. Open, so we are not kaambaan-only (§7). */
  externalSource: z.string().min(1).optional(),

  state: RunState,

  /** `acp_events.seq` of the prompt that opened this run. */
  startSeq: z.number().int().nonnegative(),
  /** `acp_events.seq` of the event that closed it; null while live. */
  endSeq: z.number().int().nonnegative().nullable().default(null),

  startedAt: z.string(),
  endedAt: z.string().nullable().default(null),
});
export type Run = z.infer<typeof Run>;

// ─── Change ──────────────────────────────────────────────────────────────────

/**
 * Where a change can be delivered. `git-remote` is the default and must remain
 * sufficient on its own — every other adapter is a convenience, never a
 * dependency (§7).
 */
export const DeliveryAdapter = z.enum(["git-remote", "github", "gitlab", "forgejo", "patch"]);
export type DeliveryAdapter = z.infer<typeof DeliveryAdapter>;

export const ChangeStatus = z.enum(["open", "landed", "abandoned"]);
export type ChangeStatus = z.infer<typeof ChangeStatus>;

/**
 * The thing that lands.
 *
 * Reserved in Horizon 0 rather than built: delivery adapters ship in Horizon 2,
 * but the schema decision cannot wait, because a peer entity everything
 * downstream keys off costs a reconciliation later if it arrives second.
 *
 * **There is deliberately no `pullRequestId`.** A change resolves to a commit
 * against a base; where it goes next is an adapter's business and nothing
 * upstream knows which forge it is headed to. The day this shape grows a
 * required forge identifier is the day we swap one vendor's lock-in for
 * another's (§7).
 *
 * `runIds` is a list because a change outlives the run that produced it — a
 * first attempt, a revision after review, a CI fix.
 */
export const Change = z.object({
  id: z.string().min(1),
  stationId: z.string().min(1),

  /** Every attempt that contributed. Runs are immutable; the change is not. */
  runIds: z.array(z.string().min(1)).default([]),

  /** The commit this change is built against. */
  baseRef: z.string().min(1),
  /** The resulting commit, once there is one. */
  headRef: z.string().min(1).nullable().default(null),

  status: ChangeStatus,

  /** How it was delivered, once it has been. Absent means "not delivered yet". */
  deliveryAdapter: DeliveryAdapter.optional(),
  /** Adapter-specific handle — a ref for git-remote, a URL for a forge, a path for a patch. */
  deliveryRef: z.string().min(1).optional(),

  createdAt: z.string(),
  updatedAt: z.string().nullable().default(null),
});
export type Change = z.infer<typeof Change>;
