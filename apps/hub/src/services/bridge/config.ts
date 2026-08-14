/**
 * The bridge's gate and its agent roster.
 *
 * Gated exactly like the provisioner drivers: one `ENABLE_*` flag, compared to
 * the literal string `"true"`, off when unset, and **nothing inferred from
 * credentials being present** — a `kbn_` token left in an env file is not a
 * decision to start claiming work on someone's board. A hub that has not opted
 * in constructs nothing, opens no session and makes no request.
 *
 * One process, many agent identities. Each entry is a separate principal with
 * its own token, board and station, because Decision 3 says an agent's
 * authority is its own rather than a projection of whoever dispatched it — so
 * "the bridge's credential" is not a thing that exists. What is shared is the
 * process, not the identity.
 */

import { AcpSessionMode } from "@agentpod/contract";
import { z } from "zod";

/** Derived nowhere and switched nowhere: one flag, one meaning. */
export const BRIDGE_ENV_FLAG = "ENABLE_KAAMBAAN_BRIDGE";

/**
 * The orchestrator this bridge speaks to, and the value written to
 * `external_source` on every row. A constant rather than configuration: the
 * client speaks kaambaan's agent contract specifically, and an operator who
 * relabelled it would produce rows that cannot be joined to anything.
 */
export const BRIDGE_SOURCE = "kaambaan";

/**
 * Why `ask` is a mode again.
 *
 * It used to be refused here. The reason was real: spike RQ2 found that
 * kaambaan defined the `input-required → working` transition and **nothing
 * invoked it** — an elicitation created no gate, and no code anywhere
 * constructed the `prompt` activity that would carry an answer back. A
 * permission request was a question nothing could answer, so every one of them
 * parked the card until the 15-minute reclaim with the harness blocked.
 *
 * kaambaan PR #36 built that return path: a human answers through
 * `POST /v1/boards/:boardId/elicitations/:elicitationId/answer`, the state
 * machine's `human_reply` moves the card back to `working`, and the answer
 * appears on the run read surface the asking agent already polls — on the same
 * lease, so the agent resumes as itself. The refusal above is now a record of
 * something fixed, kept because the reason it was right is the reason the fix
 * had to be built somewhere.
 *
 * The default is deliberately NOT `ask`. A default is what an unattended board
 * gets, `ask` asks about every tool call, and a hub upgraded into it would
 * start parking cards on questions nobody is awake to answer. `accept-edits` is
 * the supervised setting an operator should reach for: file writes proceed,
 * anything that executes waits for a human.
 */

/** The wait, when an agent does not set its own. See `permissionWaitMs`. */
export const DEFAULT_PERMISSION_WAIT_MS = 30 * 60_000;

export const BridgeAgentConfig = z.object({
  /** Stable name for logs and `bridge_dispatches.agent_key`. Must be unique. */
  key: z.string().min(1),
  boardId: z.string().min(1),
  /** This agent's own kaambaan credential. */
  token: z.string().startsWith("kbn_", 'a kaambaan agent token starts with "kbn_"'),
  /** The station its work runs on. */
  stationId: z.string().min(1),
  /**
   * The hub user the ACP session belongs to. The session machinery authorizes
   * every call by user id (`getStation(userId, …)`, `requireLive`), so a
   * background worker needs a real owning principal — it cannot invent one.
   */
  hubUserId: z.string().min(1),
  mode: AcpSessionMode.default("full-auto"),
  /**
   * How long a human has to answer a permission request before the run fails.
   *
   * Per-agent, because attendance is a property of a deployment, not of the
   * bridge: a board somebody watches during office hours wants minutes, and one
   * that runs unattended overnight wants the harness released quickly rather
   * than a station pinned until morning. Unset means the default declared
   * above — thirty minutes.
   *
   * Named in prose rather than as a backticked constant on purpose: the docs
   * audit scans this file for a SCREAMING_SNAKE name in quotes and reads every
   * one as an environment variable being named to an operator. That premise is
   * worth keeping true, and the duration is what a reader wants anyway.
   *
   * Not bounded by the lease: the bridge heartbeats throughout, so kaambaan's
   * 15-minute reclaim never fires on a waiting run. The bound is policy.
   */
  permissionWaitMs: z.number().int().positive().optional(),
  /** How many of this agent's runs may be in flight. kaambaan defaults to 1. */
  maxConcurrency: z.number().int().positive().optional(),
  /** kaambaan profile to claim under, when the board routes by profile. */
  profileKey: z.string().optional(),
});
export type BridgeAgentConfig = z.infer<typeof BridgeAgentConfig>;

export interface BridgeConfig {
  baseUrl: string;
  source: string;
  agents: BridgeAgentConfig[];
}

export function isBridgeEnabled(): boolean {
  return process.env[BRIDGE_ENV_FLAG] === "true";
}

/**
 * The roster, or null when the bridge is off.
 *
 * Throws when it is on and misconfigured. That is deliberate and matches
 * `validateConfig`: a bridge that silently claimed nothing because its roster
 * failed to parse would look exactly like a quiet board.
 */
export function loadBridgeConfig(): BridgeConfig | null {
  if (!isBridgeEnabled()) return null;

  const baseUrl = (process.env.KAAMBAAN_BASE_URL ?? "").trim();
  if (!baseUrl) {
    throw new Error(
      `KAAMBAAN_BASE_URL is required when ${BRIDGE_ENV_FLAG}=true — the origin of the kaambaan deployment to claim work from, e.g. https://kaambaan.dev`,
    );
  }

  const raw = (process.env.KAAMBAAN_BRIDGE_AGENTS ?? "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "[]");
  } catch {
    throw new Error(
      `KAAMBAAN_BRIDGE_AGENTS is not valid JSON — expected an array of {key, boardId, token, stationId, hubUserId, mode?, permissionWaitMs?, maxConcurrency?, profileKey?}`,
    );
  }

  const agents = z.array(BridgeAgentConfig).parse(parsed);
  if (agents.length === 0) {
    throw new Error(
      `KAAMBAAN_BRIDGE_AGENTS must list at least one agent when ${BRIDGE_ENV_FLAG}=true — an enabled bridge with no identities claims nothing and looks like an idle board`,
    );
  }

  const seen = new Set<string>();
  for (const a of agents) {
    // `key` is written to bridge_dispatches.agent_key and appears in every log
    // line. Two identities under one name make attribution unanswerable.
    if (seen.has(a.key)) throw new Error(`KAAMBAAN_BRIDGE_AGENTS: duplicate agent key "${a.key}"`);
    seen.add(a.key);
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), source: BRIDGE_SOURCE, agents };
}
