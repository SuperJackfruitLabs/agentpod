/**
 * The bridge's gate and its agent roster.
 *
 * Gated exactly like the provisioner drivers: one `ENABLE_*` flag, compared to
 * the literal string `"true"`, off when unset, and **nothing inferred from
 * credentials being present** — a `spa_` token left in an env file is not a
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
export const BRIDGE_ENV_FLAG = "ENABLE_SUPERPIPELINE_BRIDGE";

/**
 * The orchestrator this bridge speaks to, and the value written to
 * `external_source` on every row. A constant rather than configuration: the
 * client speaks superpipeline's agent contract specifically, and an operator who
 * relabelled it would produce rows that cannot be joined to anything.
 */
export const BRIDGE_SOURCE = "superpipeline";

/**
 * Why `ask` is a mode again.
 *
 * It used to be refused here. The reason was real: spike RQ2 found that
 * superpipeline defined the `input-required → working` transition and **nothing
 * invoked it** — an elicitation created no gate, and no code anywhere
 * constructed the `prompt` activity that would carry an answer back. A
 * permission request was a question nothing could answer, so every one of them
 * parked the card until the 15-minute reclaim with the harness blocked.
 *
 * superpipeline PR #36 built that return path: a human answers through
 * `POST /v1/boards/:boardId/elicitations/:elicitationId/answer`, the state
 * machine's `human_reply` moves the card back to `working`, and the answer
 * appears on the run read surface the asking agent already polls — on the same
 * lease, so the agent resumes as itself. The refusal above is now a record of
 * something fixed, kept because the reason it was right is the reason the fix
 * had to be built somewhere.
 *
 * The default is deliberately NOT `ask`. A default is what an unattended board gets, and a hub
 * upgraded into `ask` would start parking cards on questions nobody is awake to answer.
 *
 * **What the mode actually controls is EDITS.** The hub's policy
 * (`acp-sessions.ts` `handlePermissionRequest`) auto-allows `kind === "edit"` under
 * `accept-edits` and parks everything else for a human — which is right, and which has never
 * once been reached for a command. Across every ACP session this hub has run, 254 tool calls of
 * kind `execute` produced ZERO permission requests; all 27 ever seen were edits. The harness
 * decides what to ask about, and none of them ask before running something. hermes is explicit:
 * its modes live in `_MODE_TO_EDIT_APPROVAL_POLICY` and every one of them is an edit policy.
 *
 * So no mode here supervises execution. Do not document one as though it does — that claim was
 * in three places and in this comment, and it was false in all four (agentpod#637).
 */

/** The wait, when an agent does not set its own. See `permissionWaitMs`. */
export const DEFAULT_PERMISSION_WAIT_MS = 30 * 60_000;

export const BridgeAgentConfig = z.object({
  /** Stable name for logs and `bridge_dispatches.agent_key`. Must be unique. */
  key: z.string().min(1),
  boardId: z.string().min(1),
  /** This agent's own superpipeline credential. */
  token: z.string().startsWith("spa_", 'a superpipeline agent token starts with "spa_"'),
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
   * Not bounded by the lease: the bridge heartbeats throughout, so superpipeline's
   * 15-minute reclaim never fires on a waiting run. The bound is policy.
   */
  permissionWaitMs: z.number().int().positive().optional(),
  /** How many of this agent's runs may be in flight. superpipeline defaults to 1. */
  maxConcurrency: z.number().int().positive().optional(),
  /** superpipeline profile to claim under, when the board routes by profile. */
  profileKey: z.string().optional(),
  /**
   * A second superpipeline credential, handed to the HARNESS so it can report on
   * its own card over MCP. Absent means the harness gets no board tools and the
   * bridge remains the only voice — which is what every agent had until now.
   *
   * **Not `token`, and never `token`.** The roster credential can claim, and an
   * agent holding it could take a second card while still working the first —
   * the objection AgentPod's own prompt contract raised against giving a
   * harness board access at all. superpipeline answers it by scoping a token to
   * `run` (superpipeline#109), so the credential that reaches the station can
   * finish the card it holds and cannot ask for another. Two fields, because
   * that difference is the whole safety argument and one field could not carry
   * it.
   *
   * Minting is a human act on superpipeline — an agent cannot mint for itself,
   * by design — so this is configured, not derived.
   */
  mcpToken: z.string().startsWith("spa_", 'a superpipeline agent token starts with "spa_"').optional(),
});
export type BridgeAgentConfig = z.infer<typeof BridgeAgentConfig>;

export interface BridgeConfig {
  baseUrl: string;
  source: string;
}

export function isBridgeEnabled(): boolean {
  return process.env[BRIDGE_ENV_FLAG] === "true";
}

/**
 * Where the bridge claims from, or null when it is off.
 *
 * **The roster is not here any more.** It was `SUPERPIPELINE_BRIDGE_AGENTS`, a JSON array of agent
 * identities and their credentials in `hub.env`, and it is now a table —
 * `services/bridge/roster.ts`, read per reconcile tick. What remains in the environment is the
 * two facts that really are deployment configuration: whether the bridge runs at all, and which
 * superpipeline it talks to.
 *
 * What is lost with it is the boot-time refusal: "a bridge that silently claimed nothing because
 * its roster failed to parse would look exactly like a quiet board" cannot be checked here, since
 * `validateConfig()` runs before `initDatabase()`. It is checked at the first reconcile instead,
 * where the table can actually be read.
 */
export function loadBridgeConfig(): BridgeConfig | null {
  if (!isBridgeEnabled()) return null;

  const baseUrl = (process.env.SUPERPIPELINE_BASE_URL ?? "").trim();
  if (!baseUrl) {
    throw new Error(
      `SUPERPIPELINE_BASE_URL is required when ${BRIDGE_ENV_FLAG}=true — the origin of the superpipeline deployment to claim work from, e.g. https://superpipeline.dev`,
    );
  }

  // Every token in `bridge_agents` is encrypted with it, so without it the roster reads as a list
  // of agents none of which can be run — an outage with no obvious cause. Checked here because it
  // IS an environment fact, and so is still reachable at boot.
  //
  // Read from `process.env` rather than through `config.encryption.key`, for the same reason the
  // base URL above is: `config` snapshots at module load AND falls back to a dev key when the
  // variable is unset, so asking it would answer "configured" for a hub that is about to encrypt
  // every credential with a value published in this repository.
  const encryptionKey = (process.env.ENCRYPTION_KEY ?? "").trim();
  if (encryptionKey.length < 32) {
    throw new Error(
      `ENCRYPTION_KEY (at least 32 characters) is required when ${BRIDGE_ENV_FLAG}=true — every rostered agent's superpipeline credential is encrypted with it, and an unset one silently falls back to the development key`,
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), source: BRIDGE_SOURCE };
}
