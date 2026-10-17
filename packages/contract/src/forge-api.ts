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
export const ForgeApiDeliverResult = z
  .object({ ok: z.boolean(), isolation: ForgeApiIsolation, stored: z.boolean() });
export const ForgeApiPolicyResult = z.object({ ok: z.boolean(), error: z.string().optional() });
export const ForgeApiVerifyResult = z
  .object({
    ok: z.boolean(),
    login: z.string().optional(),
    reason: z.string().optional(),
    isolation: ForgeApiIsolation,
  });
export const ForgeApiRevokeResult = z.object({ removed: z.boolean() });
export const ForgeApiStatusResult = z
  .object({
    grants: z.array(
      z.object({ grantId: z.string(), present: z.boolean(), isolation: ForgeApiIsolation }),
    ),
  });
