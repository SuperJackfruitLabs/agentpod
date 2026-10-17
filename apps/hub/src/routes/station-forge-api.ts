/**
 * Forge API access routes (spec docs/superpowers/specs/2026-10-17-forge-api-access-design.md):
 *
 *   GET    /api/stations/:id/forge-api                              status (owner or operator)
 *   GET    /api/stations/:id/forge-api/key                          the station's stk handover public key
 *                                                                   (operator; the CLI seals supplied/app
 *                                                                   credentials to it)
 *   POST   /api/stations/:id/forge-api                              grant
 *   POST   /api/stations/:id/forge-api/:grantId/verify
 *   POST   /api/stations/:id/forge-api/:grantId/rotate              minted
 *   POST   /api/stations/:id/forge-api/:grantId/secret              supplied/app: a sealed envelope
 *   PATCH  /api/stations/:id/forge-api/:grantId/policy
 *   DELETE /api/stations/:id/forge-api/:grantId                     revoke
 *   POST   /api/stations/:id/forge-api/:grantId/confirm-revoked     supplied: the operator revoked it
 *
 * **Authority.** Granting an agent a forge credential is granting it reach. Every mutation needs
 * BOTH the hub operator seat (`isUserAdmin`) AND the control pair (`requireIssueCredentials`, the
 * same check `station-matrix.ts` uses for a Matrix credential; it enforces under
 * ENFORCE_CONTROL_PAIR). Owning the station is NOT enough — unlike `station-git-identity.ts`, whose
 * ownership-only check must not be copied here. Agent tokens never get this far (authMiddleware
 * refuses a non-human plane token), and node credentials authenticate only on node routes.
 *
 * **The account is never taken from a body.** Every body schema is strict: an `account`,
 * `principal` or any unknown field is a 400. A minted grant's account is the occupant's handle; a
 * supplied/app grant's is the operator-declared `expectedLogin`.
 *
 * **Responses are a sanitised view** (`viewOf`): never the sealed blob, the token handle (not even
 * its name or id), `previous`/`orphan`, or a token. Error bodies are `{error: code, message}` with
 * a message chosen here from the code — never a provider's, a node's or the service's own text.
 *
 * **Lookup is tenant-scoped**: a station or grant outside the caller's tenant is 404.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  ForgeApiMode,
  ForgeApiPreset,
  ForgeApiProvider,
  ForgeApiRule,
  STK_HANDOVER_PREFIX,
  type ForgeApiProvider as ProviderKind,
} from "@agentpod/contract";

import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { stationForgeApiGrants as g, type StationForgeApiGrant } from "../db/schema/forge-api-grants";
import { isUserAdmin } from "../models/admin-users";
import { requireIssueCredentials } from "../services/grant-reach";
import { isGrantReachDenied } from "../services/control-pair";
import { recordAudit } from "../services/audit";
import * as broker from "../services/broker";
import type { FetchLike, ForgeConfig } from "../services/forge";
import { getProvider } from "../services/forge-api/providers";
import { ForgeApiConfigError } from "../services/forge-api/errors";
import { instanceOrigin, isConfiguredForge, isIpLiteral } from "../services/forge-api/instance";
import {
  ForgeApiGrantError,
  SUPPLIED_BLOB_MAX,
  untrusted,
  acceptSuppliedSecret,
  fetchStationPublicKey,
  confirmSuppliedRevoked,
  createForgeApiGrant,
  revokeGrant,
  rotateGrant,
  updateGrantPolicy,
  verifyGrant,
  type ForgeApiDeps,
} from "../services/station-forge-api";
import { createLogger } from "../utils/logger";
import type { AuthUser } from "../auth/middleware";

const log = createLogger("station-forge-api-route");

// The request-size ceiling for every forge-api route, derived from the one envelope cap so the two
// cannot drift: a /secret body is the envelope plus a few bytes of JSON (its schema holds the
// envelope to SUPPLIED_BLOB_MAX); a grant body (repositories, rules) stays well under it.
export const FORGE_API_BODY_MAX = 4 * SUPPLIED_BLOB_MAX;

export interface StationForgeApiDeps {
  /** Null when no forge admin credential is configured; mutations then answer 503. */
  forge: ForgeConfig | null;
  fetchImpl?: FetchLike;
  /** Test seam: replaces parts of the service deps (broker, providers, seal, now). */
  service?: Partial<ForgeApiDeps>;
}

// ─── Bodies ───────────────────────────────────────────────────────────────────

/**
 * An https origin: no credentials, no path beyond `/`, no query or fragment, no trailing-dot host.
 * Normalised to the origin (lower-cased host, no trailing slash). IP-literal hosts are refused for
 * supplied/app grants in `GrantBody` (a forge or GHE is addressed by name); a minted grant must be
 * the configured forge exactly (checked here early and, authoritatively, in the service).
 *
 * Private NAMES are not refused: whether `git.internal` is reachable is a node-network concern. The
 * hub never contacts a supplied/app instance — the node's stk does — and only an operator (admin +
 * control pair) can create a grant, so this is not a hub-side SSRF surface.
 */
const Instance = z
  .string()
  .max(512)
  .transform((s, ctx) => {
    const origin = instanceOrigin(s);
    if (!origin) {
      ctx.addIssue({ code: "custom", message: "instance must be a bare https origin" });
      return z.NEVER;
    }
    return origin;
  });

const Repository = z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const Login = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/);

const GrantBody = z
  .object({
    provider: ForgeApiProvider,
    instance: Instance,
    mode: ForgeApiMode,
    repositories: z.array(Repository).min(1).max(50),
    preset: ForgeApiPreset,
    // `ForgeApiRule.when` is passed through to stk unevaluated; it is bounded only by the 64 KiB
    // body limit (and stk validates it at reload).
    rules: z.array(ForgeApiRule).max(100).optional(),
    allowGraphql: z.boolean().optional(),
    expectedLogin: Login.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.mode !== "minted" && !b.expectedLogin) {
      ctx.addIssue({ code: "custom", message: "expectedLogin is required for app and supplied grants" });
    }
    if (b.mode !== "minted" && isIpLiteral(new URL(b.instance).hostname)) {
      ctx.addIssue({ code: "custom", path: ["instance"], message: "instance must be a host name, not an IP" });
    }
  });

const SecretBody = z
  .object({ sealed: z.string().startsWith(STK_HANDOVER_PREFIX).max(SUPPLIED_BLOB_MAX) })
  .strict();

const PolicyBody = z
  .object({ preset: ForgeApiPreset, rules: z.array(ForgeApiRule).max(100), allowGraphql: z.boolean() })
  .strict();

const EmptyBody = z.object({}).strict();

// ─── Responses ────────────────────────────────────────────────────────────────

/**
 * What a caller may see of a grant. `state` is the truth about delivery: `deliveredAt` is not
 * exposed, because a rotation clears it while the previous credential is still live.
 */
export function viewOf(row: StationForgeApiGrant, now = new Date()) {
  return {
    id: row.id,
    stationId: row.stationId,
    provider: row.provider,
    instance: row.instance,
    mode: row.mode,
    account: row.account,
    expectedLogin: row.expectedLogin,
    repositories: row.repositories,
    preset: row.preset,
    rules: row.rules,
    allowGraphql: row.allowGraphql,
    state: row.state,
    // Capped and stripped: a reason can carry provider- or node-derived text.
    stateReason: row.stateReason === null ? null : untrusted(row.stateReason),
    generation: row.generation,
    isolation: row.isolation,
    hasPendingCredential:
      row.sealedBlob !== null && row.sealedExpiresAt !== null && row.sealedExpiresAt.getTime() > now.getTime(),
    rotation: row.tokenHandle?.previous?.disposition === "live-until-verified" ? ("pending" as const) : null,
    // Only whether a policy change awaits the node's confirmation; never when.
    policyPending: row.policyPendingSince !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    verifiedAt: row.verifiedAt,
    revokedAt: row.revokedAt,
  };
}

/** Fixed text per code: an error body never carries service, provider or node text. */
const MESSAGES: Record<string, string> = {
  "no-occupant": "This station has no occupying agent to grant forge access to.",
  "capability-missing": "This station's node does not support forge API access; update the node.",
  "station-key-unavailable": "The station's node did not provide its handover key; is it online?",
  "grant-exists": "This station already has a live grant for that forge.",
  "grant-revoking": "This station's grant for that forge is being revoked; revocation is in progress, try again once it is revoked.",
  "grant-busy": "Another operation on this grant is in progress; try again.",
  "grant-not-found": "No such grant on this station.",
  "mint-failed": "The forge refused to create the token.",
  "revoke-failed": "The forge refused to revoke the token.",
  "rotation-failed": "The rotation could not complete; the previous credential was kept or queued for revocation.",
  "handle-persist-failed": "The token could not be recorded; it was revoked.",
  "bad-sealed-blob": "The credential must be a sealed stk handover envelope.",
  "preset-none-needs-no-token": "Preset 'none' needs no token.",
  "instance-not-forge": "A minted grant's instance must be this hub's configured forge.",
};

const messageFor = (code: string) => MESSAGES[code] ?? `The forge grant step was refused (${code}).`;

function mapError(err: unknown): { status: number; code: string } {
  if (err instanceof ForgeApiGrantError || err instanceof ForgeApiConfigError) {
    return { status: err.status, code: err.code };
  }
  return { status: 500, code: "internal" };
}

const fail = (c: Context, status: number, code: string) =>
  c.json({ error: code, message: messageFor(code) }, status as 400);

// ─── Routes ───────────────────────────────────────────────────────────────────

type Station = typeof stations.$inferSelect;

export function createStationForgeApiRoutes(deps: StationForgeApiDeps) {
  const limit = bodyLimit({
    maxSize: FORGE_API_BODY_MAX,
    onError: (c) => c.json({ error: "body-too-large", message: "Request body too large." }, 413),
  });

  function serviceDeps(forge: ForgeConfig): ForgeApiDeps {
    return {
      db,
      broker,
      providers: (kind: ProviderKind) => {
        try {
          return getProvider(kind, { cfg: forge, fetchImpl: deps.fetchImpl });
        } catch {
          throw new ForgeApiGrantError("mode-not-supported", `forge: provider ${kind} is not supported yet.`);
        }
      },
      now: () => new Date(),
      forgeOrigin: forge.baseUrl,
      // Loaded on use: libsodium has no business in the route module's import graph.
      seal: async (pk, material) => (await import("../services/handover-seal")).sealHandover(pk, material),
      ...deps.service,
    };
  }

  async function caller(c: Context): Promise<AuthUser | null> {
    const user = c.get("user") as AuthUser | undefined;
    return user && user.id !== "anonymous" ? user : null;
  }

  /** The station, in the caller's tenant only. */
  async function stationFor(user: AuthUser, id: string): Promise<Station | null> {
    const [row] = await db
      .select()
      .from(stations)
      .where(and(eq(stations.id, id), eq(stations.tenantId, user.tenantId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The gate every mutation passes, in order: caller → station (404) → operator seat (403) →
   * control pair (403) → forge configured (503). Returns the station or a response.
   */
  async function authorise(c: Context): Promise<{ user: AuthUser; station: Station; forge: ForgeConfig } | Response> {
    const user = await caller(c);
    if (!user) return c.json({ error: "unauthorized", message: "Sign in." }, 401);
    const station = await stationFor(user, c.req.param("id")!);
    const admin = await isUserAdmin(user.id);
    if (!station || (!admin && station.userId !== user.id)) {
      return c.json({ error: "not-found", message: "No such station." }, 404);
    }
    if (!admin) {
      log.warn("forge API mutation refused: caller is not an operator", { userId: user.id, stationId: station.id });
      return c.json(
        { error: "operator-required", message: "Granting forge API access is an operator action." },
        403,
      );
    }
    try {
      await requireIssueCredentials(user, { nodeId: station.nodeId, stationKey: station.stationKey });
    } catch (e) {
      if (!isGrantReachDenied(e)) throw e;
      return c.json(
        {
          error: "reach-denied",
          message:
            "Issuing an agent a forge credential is granting it reach, which your grant does not permit for this agent.",
        },
        403,
      );
    }
    if (!deps.forge) return fail(c, 503, "forge-not-configured");
    return { user, station, forge: deps.forge };
  }

  async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T | Response> {
    let raw: unknown = {};
    try {
      const text = await c.req.text();
      if (text.trim() !== "") raw = JSON.parse(text);
    } catch {
      return c.json({ error: "bad-request", message: "Body must be JSON." }, 400);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      // Field paths only: an issue message could quote a pasted secret.
      const fields = parsed.error.issues.map((i) => i.path.join(".") || "(body)");
      if (fields.includes("instance")) {
        return c.json({ error: "invalid-instance", message: "instance must be a bare https origin addressed by name." }, 400);
      }
      return c.json({ error: "bad-request", message: `Invalid or unexpected fields: ${[...new Set(fields)].join(", ")}` }, 400);
    }
    return parsed.data;
  }

  async function grantFor(station: Station, grantId: string): Promise<StationForgeApiGrant | null> {
    const [row] = await db
      .select()
      .from(g)
      .where(and(eq(g.tenantId, station.tenantId), eq(g.id, grantId), eq(g.stationId, station.id)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Audit before, outcome after. Params are ids and enums only (all on SAFE_PARAM_KEYS); the actor
   * is both the row's user and an `actor` param.
   */
  async function audited<T>(
    c: Context,
    a: { user: AuthUser; station: Station },
    action: string,
    params: { grantId?: string; provider?: string; mode?: string; preset?: string; generation?: number },
    run: () => Promise<T>,
    respond: (out: T) => Response | Promise<Response>,
  ): Promise<Response> {
    const handle = await recordAudit(db, {
      userId: a.user.id,
      nodeId: a.station.nodeId,
      stationKey: a.station.stationKey,
      verb: `forge.api.route.${action}`,
      params: { actor: a.user.id, stationKey: a.station.stationKey, action, ...params },
    });
    let out: T;
    try {
      out = await run();
    } catch (err) {
      const { status, code } = mapError(err);
      if (status >= 500 && code === "internal") {
        log.error("forge API route failed", { action, stationId: a.station.id, grantId: params.grantId });
      }
      await handle.done("error", code).catch(() => {});
      return fail(c, status, code);
    }
    await handle.done("ok").catch(() => {});
    return respond(out);
  }

  const forGrant = (fn: (c: Context, a: { user: AuthUser; station: Station; forge: ForgeConfig }, grant: StationForgeApiGrant) => Promise<Response>) =>
    async (c: Context) => {
      const a = await authorise(c);
      if (a instanceof Response) return a;
      const grant = await grantFor(a.station, c.req.param("grantId")!);
      if (!grant) return fail(c, 404, "grant-not-found");
      return fn(c, a, grant);
    };

  const refOf = (grant: StationForgeApiGrant) => ({ tenantId: grant.tenantId, grantId: grant.id });
  const paramsOf = (grant: StationForgeApiGrant) => ({
    grantId: grant.id,
    provider: grant.provider,
    mode: grant.mode,
    preset: grant.preset,
    generation: grant.generation,
  });

  return (
    new Hono()
      .use("/stations/:id/forge-api", limit)
      .use("/stations/:id/forge-api/*", limit)

      /** Status: owner or operator. No audit row; it is a read. */
      .get("/stations/:id/forge-api", async (c) => {
        const user = await caller(c);
        if (!user) return c.json({ error: "unauthorized", message: "Sign in." }, 401);
        const station = await stationFor(user, c.req.param("id"));
        if (!station || (station.userId !== user.id && !(await isUserAdmin(user.id)))) {
          return c.json({ error: "not-found", message: "No such station." }, 404);
        }
        const rows = await db
          .select()
          .from(g)
          .where(and(eq(g.tenantId, station.tenantId), eq(g.stationId, station.id)))
          .orderBy(desc(g.createdAt));
        const now = new Date();
        return c.json({ grants: rows.map((r) => viewOf(r, now)) });
      })

      /**
       * The station's stk handover public key, so `fleet stations forge-api grant|secret` can seal a
       * supplied/app credential on the operator's machine: the plaintext never reaches the hub. Same
       * gate as a mutation (handing out the key is the first step of granting reach), audited, and
       * the response is `{publicKey}` and nothing else.
       */
      .get("/stations/:id/forge-api/key", async (c) => {
        const a = await authorise(c);
        if (a instanceof Response) return a;
        return audited(
          c,
          a,
          "key",
          {},
          () => fetchStationPublicKey(serviceDeps(a.forge), { id: a.station.id, nodeId: a.station.nodeId }),
          (publicKey) => c.json({ publicKey }),
        );
      })

      .post("/stations/:id/forge-api", async (c) => {
        const a = await authorise(c);
        if (a instanceof Response) return a;
        const b = await body(c, GrantBody);
        if (b instanceof Response) return b;
        return audited(
          c,
          a,
          "grant",
          { provider: b.provider, mode: b.mode, preset: b.preset },
          async () => {
            // Early, before any claim or key fetch; the service repeats it and is the authority.
            if (b.mode === "minted" && !isConfiguredForge(b.instance, a.forge.baseUrl)) {
              throw new ForgeApiConfigError("instance-not-forge", "instance is not the configured forge");
            }
            return createForgeApiGrant(serviceDeps(a.forge), {
              tenantId: a.station.tenantId,
              stationId: a.station.id,
              actor: a.user.id,
              provider: b.provider,
              instance: b.instance,
              mode: b.mode,
              repositories: b.repositories,
              preset: b.preset,
              rules: b.rules ?? [],
              allowGraphql: b.allowGraphql ?? false,
              expectedLogin: b.expectedLogin,
            });
          },
          (grant) => c.json({ grant: viewOf(grant) }),
        );
      })

      .post(
        "/stations/:id/forge-api/:grantId/verify",
        forGrant(async (c, a, grant) => {
          const b = await body(c, EmptyBody);
          if (b instanceof Response) return b;
          return audited(c, a, "verify", paramsOf(grant), () => verifyGrant(serviceDeps(a.forge), refOf(grant)), (r) =>
            c.json({ outcome: r.outcome, grant: viewOf(r.grant) }),
          );
        }),
      )

      .post(
        "/stations/:id/forge-api/:grantId/rotate",
        forGrant(async (c, a, grant) => {
          const b = await body(c, EmptyBody);
          if (b instanceof Response) return b;
          return audited(c, a, "rotate", paramsOf(grant), () => rotateGrant(serviceDeps(a.forge), refOf(grant)), (row) =>
            c.json({ grant: viewOf(row) }),
          );
        }),
      )

      .post(
        "/stations/:id/forge-api/:grantId/secret",
        forGrant(async (c, a, grant) => {
          const b = await body(c, SecretBody);
          if (b instanceof Response) return b;
          return audited(
            c,
            a,
            "secret",
            paramsOf(grant),
            () => acceptSuppliedSecret(serviceDeps(a.forge), { ...refOf(grant), sealed: b.sealed }),
            (row) => c.json({ grant: viewOf(row) }),
          );
        }),
      )

      .patch(
        "/stations/:id/forge-api/:grantId/policy",
        forGrant(async (c, a, grant) => {
          const b = await body(c, PolicyBody);
          if (b instanceof Response) return b;
          return audited(
            c,
            a,
            "policy",
            { ...paramsOf(grant), preset: b.preset },
            () => updateGrantPolicy(serviceDeps(a.forge), { ...refOf(grant), ...b }),
            (r) => c.json({ outcome: r.outcome, grant: viewOf(r.grant) }),
          );
        }),
      )

      .delete(
        "/stations/:id/forge-api/:grantId",
        forGrant(async (c, a, grant) => {
          const b = await body(c, EmptyBody);
          if (b instanceof Response) return b;
          return audited(c, a, "revoke", paramsOf(grant), () => revokeGrant(serviceDeps(a.forge), refOf(grant)), (r) =>
            c.json({ outcome: r.outcome, grant: viewOf(r.grant) }),
          );
        }),
      )

      .post(
        "/stations/:id/forge-api/:grantId/confirm-revoked",
        forGrant(async (c, a, grant) => {
          const b = await body(c, EmptyBody);
          if (b instanceof Response) return b;
          return audited(
            c,
            a,
            "confirm-revoked",
            paramsOf(grant),
            () => confirmSuppliedRevoked(serviceDeps(a.forge), refOf(grant)),
            (r) => c.json({ outcome: r.outcome, grant: viewOf(r.grant) }),
          );
        }),
      )
  );
}
