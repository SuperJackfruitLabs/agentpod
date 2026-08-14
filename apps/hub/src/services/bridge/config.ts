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
 * Modes that do not block on a human.
 *
 * Spike RQ2 found the return path does not exist: kaambaan defines the
 * `input-required → working` transition in its state machine and **nothing in
 * `apps/api/src` invokes it**, no gate is created by an elicitation, and no code
 * anywhere constructs the `prompt` activity that would carry an answer back. In
 * `ask` mode every permission request would therefore park the card until the
 * 15-minute heartbeat reclaim, with the harness blocked the whole time. Refused
 * at load, where the operator can read why.
 */
const NON_BLOCKING_MODES = ["accept-edits", "full-auto"] as const;

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
  mode: AcpSessionMode.default("full-auto").refine(
    (m) => (NON_BLOCKING_MODES as readonly string[]).includes(m),
    {
      message:
        'mode "ask" is refused: a permission request becomes a kaambaan elicitation, and kaambaan has no return path for one — the input-required → working transition exists in its state machine and nothing invokes it, so the card would park until the 15-minute reclaim with the harness blocked (spike RQ2). Use "accept-edits" or "full-auto".',
    },
  ),
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
      `KAAMBAAN_BRIDGE_AGENTS is not valid JSON — expected an array of {key, boardId, token, stationId, hubUserId, mode?, maxConcurrency?, profileKey?}`,
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
