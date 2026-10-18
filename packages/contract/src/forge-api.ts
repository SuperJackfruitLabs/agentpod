import { z } from "zod";

/**
 * Forge API access: the hub mints (or is handed) a forge token, SEALS it to the node's stk broker,
 * and the node stores it. These are the frames that carry that out.
 *
 * The rule every schema here enforces: a credential never rides in a frame in the clear. The only
 * secret-bearing field is `sealed`, and it must be an stk handover envelope. Every object is
 * `.strict()` so a frame that grows a `token`, `secret` or `password` key is REJECTED rather than
 * silently stripped — stripping would hide the mistake that put it there.
 */

export const ForgeApiMode = z.enum(["minted", "app", "supplied"]);
export type ForgeApiMode = z.infer<typeof ForgeApiMode>;
export const ForgeApiProvider = z.enum(["forgejo", "gitea", "github", "bitbucket"]);
export type ForgeApiProvider = z.infer<typeof ForgeApiProvider>;
export const ForgeApiPreset = z.enum(["read", "issues", "pull-requests", "maintain", "none"]);
export type ForgeApiPreset = z.infer<typeof ForgeApiPreset>;
export const ForgeApiIsolation = z.enum(["separate-user", "same-user"]);
export type ForgeApiIsolation = z.infer<typeof ForgeApiIsolation>;

export const ForgeApiRule = z
  .object({
    allow: z.string().optional(),
    deny: z.string().optional(),
    when: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ForgeApiRule = z.infer<typeof ForgeApiRule>;

/** The prefix of stk's frozen handover envelope (docs/handover-v1.md in supertoolkit). */
export const STK_HANDOVER_PREFIX = "stk-handover-v1:";
/**
 * The largest supplied/app sealed envelope the hub accepts, in characters (a PAT or an App key
 * sealed is a few KiB). The fleet CLI refuses a larger one BEFORE creating the grant; its Go
 * constant is held to this literal by a test, so keep it a plain number.
 */
export const FORGE_API_SEALED_MAX = 16384;

export const ForgeApiDeliverParams = z
  .object({
    stationId: z.string().min(1),
    stationKey: z.string().min(1),
    grantId: z.string().min(1),
    provider: ForgeApiProvider,
    /** Base URL of the forge instance. */
    instance: z.string().min(1),
    mode: ForgeApiMode,
    serviceName: z.string().min(1),
    repositories: z.array(z.string()),
    preset: ForgeApiPreset,
    rules: z.array(ForgeApiRule),
    allowGraphql: z.boolean(),
    /** The token, sealed to the node's broker key. Never plaintext. */
    sealed: z
      .string()
      .refine((s) => s.startsWith(STK_HANDOVER_PREFIX) && s.length > STK_HANDOVER_PREFIX.length, {
        message: `sealed must be a ${STK_HANDOVER_PREFIX} envelope`,
      }),
    expectLogin: z.string().min(1),
  })
  .strict();

export const ForgeApiPolicyParams = z
  .object({
    stationId: z.string().min(1),
    grantId: z.string().min(1),
    preset: ForgeApiPreset,
    rules: z.array(ForgeApiRule),
    allowGraphql: z.boolean(),
  })
  .strict();

export const ForgeApiVerifyParams = z
  .object({ stationId: z.string().min(1), grantId: z.string().min(1), expectLogin: z.string().min(1) })
  .strict();

export const ForgeApiRevokeParams = z
  .object({ stationId: z.string().min(1), grantId: z.string().min(1) })
  .strict();

export const ForgeApiStatusParams = z.object({ stationId: z.string().min(1) }).strict();

// Results are deliberately NOT strict: hub and nodes deploy independently, and a newer node adding a
// field must not make a healthy reply unreadable. Params stay strict (no credential in a frame).
export const ForgeApiDeliverResult = z.object({
  ok: z.boolean(),
  isolation: ForgeApiIsolation,
  stored: z.boolean(),
  /**
   * The station's harness was already running when its stk environment changed, and a running
   * process keeps the environment it started with: it must be restarted to use the grant. The node
   * does not restart it itself (it cannot know the agent is not mid-turn). Older nodes omit it.
   */
  needsRestart: z.boolean().optional(),
  /** The systemd units whose environment file the node wrote for this station. Older nodes omit it. */
  wired: z.array(z.string()).optional(),
});
export const ForgeApiPolicyResult = z.object({ ok: z.boolean(), error: z.string().optional() });
/**
 * stk's `forge.api.verify` reason codes, exactly. The node puts one first in `reason` (optionally
 * followed by `: detail`). The result's `reason` stays a lenient string so a newer stk adding a code
 * does not make a reply unreadable; the hub maps by the first token and treats an unknown one as
 * inconclusive.
 */
export const ForgeApiVerifyReasons = [
  "unauthorized",
  "forbidden",
  "unreachable",
  "unexpected-response",
  "server-error",
  "redirect",
  "wrong-identity",
  "repository-missing",
  "unsupported",
] as const;
export type ForgeApiVerifyReason = (typeof ForgeApiVerifyReasons)[number];

/** The outcomes of the node's bypass check for one client. A newer node may add one: stay lenient. */
export const ForgeApiBypassOutcomes = ["honoured", "bypassed", "refused-ca", "untested", "failed"] as const;
export type ForgeApiBypassOutcome = (typeof ForgeApiBypassOutcomes)[number];

/**
 * What the node measured and what it wired, on a verify. `clients` are measured against a local
 * stand-in (stk's probe, then the station's harness client where a safe probe exists: otherwise
 * `untested`, never `honoured`); `paths` and `brokered` are the node's record of what it routed
 * through the station's broker. A node sets `ok: false` with a `reason` starting `bypassed:` when a
 * client bypassed the broker and `not-wired:` when no path of the harness is routed; neither is one
 * of stk's codes, so the hub reads them as not verified. Older nodes omit the whole field.
 */
export const ForgeApiBypass = z.object({
  clients: z.array(z.object({ client: z.string(), outcome: z.string() })),
  harness: z.string().optional(),
  paths: z
    .array(
      z.object({
        path: z.string(),
        wired: z.boolean(),
        units: z.array(z.string()).optional(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
  /** True only when every path is wired and nothing blocks the wiring. */
  brokered: z.boolean(),
  /** Why a path is not routed (a proxy variable the harness already sets); names only. */
  wiringBlocked: z.string().optional(),
});
export type ForgeApiBypass = z.infer<typeof ForgeApiBypass>;

export const ForgeApiVerifyResult = z
  .object({
    ok: z.boolean(),
    login: z.string().optional(),
    reason: z.string().optional(),
    isolation: ForgeApiIsolation,
    bypass: ForgeApiBypass.optional(),
  });
export const ForgeApiRevokeResult = z.object({
  removed: z.boolean(),
  /** See ForgeApiDeliverResult.needsRestart: a running harness still holds the revoked wiring. */
  needsRestart: z.boolean().optional(),
  /** What remains wired after the revoke. */
  wired: z.array(z.string()).optional(),
});
export const ForgeApiStatusResult = z
  .object({
    grants: z.array(
      z.object({ grantId: z.string(), present: z.boolean(), isolation: ForgeApiIsolation }),
    ),
    /** The station's stk handover PUBLIC key; the hub seals deliveries to it. Older nodes omit it. */
    publicKey: z.string().startsWith(STK_HANDOVER_PREFIX).optional(),
  });
