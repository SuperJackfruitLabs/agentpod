/**
 * The device credential a human exchanges at a terminal.
 *
 * `charter → decisions/2026-09-18-a-human-at-a-terminal-has-nothing-to-exchange.md`,
 * accepted 2026-09-20. Four routes:
 *
 *   POST   /api/auth/devices        create one; the secret is returned ONCE
 *   POST   /api/auth/devices/token  exchange `dev_…:secret` for a 5-minute token
 *   GET    /api/auth/devices        this user's devices, for a list they can revoke from
 *   DELETE /api/auth/devices/:id    revoke one
 *
 * **All four self-authenticate and are registered ahead of `authMiddleware`**, for
 * the reason `fleet-dispatchable.ts` gives: that middleware accepts a Better Auth
 * session, a session-token bearer or the static API_TOKEN, and never a hub-issued
 * JWT. `fleet login` holds exactly a hub JWT at the moment it needs to create a
 * device, and the console holds a session — so the three management routes accept
 * either, through one helper, and the exchange route accepts neither because its
 * credential IS the device.
 */

import { Hono, type Context } from "hono";

import { auth } from "../auth/drizzle-auth";
import { verifyHubToken } from "../auth/hub-token";
import { buildTokenPayload, TOKEN_TTL } from "../auth/jwt-claims";
import { signServiceToken } from "../auth/service-signing";
import { resolveTenantForUser } from "../auth/tenant";
import { findOAuthClient, oauthClients, type OAuthClient } from "../config";
import { db } from "../db/drizzle";
import { user as userTable } from "../db/schema/auth";
import { eq } from "drizzle-orm";
import {
  exchangeDeviceCredential,
  listDeviceCredentials,
  mintDeviceCredential,
  revokeDeviceCredential,
} from "../services/device-credentials";

/** Who is asking, for the three routes that manage devices rather than being one. */
interface Caller {
  userId: string;
  tenantId: string;
}

/**
 * Resolve a Better Auth session OR a hub token to a user, or null.
 *
 * The refusals here are the security of this file, and each is load-bearing:
 *
 *   - **`principalKind` must be `human`.** A node can exchange its own credential
 *     for a token naming a station's agent principal, so "a valid hub token" and
 *     "a person" are not the same thing. An agent must not mint itself a
 *     ninety-day credential.
 *
 *   - **`act` is refused.** A bridge asserting a human's identity carries that
 *     human's reach for the act in front of it; it is not that human standing at
 *     a terminal asking for a long-lived key.
 *
 *   - **`amr: ["device"]` is refused, and this is the one that is easy to miss.**
 *     Without it, a stolen device credential mints a second device credential,
 *     and revoking the first accomplishes nothing because the thief already holds
 *     one that was never on the list the operator was reading. A device credential
 *     must be obtainable only from a browser flow a person completed. It is the
 *     difference between revocation working and revocation looking like it worked.
 *
 *   - **The subject must be a row in `user`.** A hub token's `sub` is a Better Auth
 *     user id for a session or exchange token, and a `prn_…` principal id for a
 *     station-minted one. Requiring the row is what tells those apart without
 *     pattern-matching a prefix, and it also refuses a token for a user since
 *     deleted.
 */
async function resolveCaller(c: Context): Promise<Caller | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  if (session?.user?.id) {
    return { userId: session.user.id, tenantId: await resolveTenantForUser(session.user.id) };
  }

  const bearer = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return null;

  const claims = await verifyHubToken(bearer);
  if (!claims) return null;
  if (claims.principalKind !== "human") return null;
  if (claims.act) return null;
  if (Array.isArray(claims.amr) && claims.amr.includes("device")) return null;

  const [row] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.id, claims.sub));
  if (!row) return null;

  return { userId: row.id, tenantId: await resolveTenantForUser(row.id) };
}

export interface DeviceRoutesDeps {
  /**
   * Which clients a token may be minted for, and what each may reach. Defaults
   * to the hub's own registry, so production reads `HUB_OAUTH_CLIENTS` exactly
   * as it always has; a test injects instead of setting module-scope env, the
   * same reason `createAuthorizeRoutes` takes it.
   */
  clients?: readonly OAuthClient[];
}

/**
 * The device routes, over a given client registry.
 *
 * A factory for one reason: the exchange now has to ask the registry what a
 * named client may reach, and a registry computed at module scope cannot be
 * varied by a test without a fresh process.
 */
export function createDeviceRoutes(deps: DeviceRoutesDeps = {}): Hono {
  const registry = deps.clients ?? oauthClients;
  return new Hono()
  /**
   * Exchange a device credential for a five-minute token.
   *
   * Registered FIRST so `/devices/token` is matched before anything could treat
   * `token` as an `:id`.
   *
   * `Authorization: Bearer <deviceId>:<secret>`, parsed exactly as
   * `station-token.ts` parses `<nodeId>:<nodeSecret>` — one scheme for every
   * long-lived credential this hub accepts.
   */
  .post("/devices/token", async (c) => {
    const bearer = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const idx = bearer.indexOf(":");
    const deviceId = idx !== -1 ? bearer.slice(0, idx) : "";
    const secret = idx !== -1 ? bearer.slice(idx + 1) : "";

    // ONE refusal for every reason: unparseable, unknown, wrong secret, revoked,
    // expired. `station-token.ts` gives the reasoning — a caller able to tell
    // "no such device" from "that device was revoked" can probe for ids — and a
    // revoked device is precisely where that probe would pay whoever took the
    // laptop. The service returns a bare null for the same reason.
    const device = await exchangeDeviceCredential(deviceId, secret);
    if (!device) return c.json({ error: "invalid device credential" }, 401);

    let payload;
    try {
      // Claims from `buildTokenPayload` and nowhere else. It resolves the
      // principal from the user at mint time — which is why this table stores no
      // principal id — and refuses outright for a suspended one, a refusal let
      // through below rather than re-implemented.
      payload = await buildTokenPayload({ user: { id: device.userId } });
    } catch {
      return c.json({ error: "no principal may be minted for this device" }, 403);
    }

    // `amr: ["device"]` — OIDC's authentication-methods reference, answering how
    // this subject authenticated. Not `act`: RFC 8693's actor claim means a
    // service spoke for someone, and here the person's own device presented the
    // person's own credential.
    //
    // superpipeline reads this and refuses to mint a thirty-day session cookie from
    // such a token (shipped there BEFORE this could produce one). The credential
    // is authority to work; it is not evidence anybody was present.
    // Which plane(s) this token is for. Absent means the hub alone, which is
    // what every caller written before this sent and still sends.
    //
    // `client`, not `client_id` — the same spelling `auth-authorize.ts` reads,
    // because a CLI that already sends `client` there should not have to
    // remember that this endpoint wanted the other name.
    const requestedClient = c.req.query("client");
    let audiences: readonly string[] | undefined;
    if (requestedClient !== undefined) {
      const client = findOAuthClient(requestedClient, registry);
      // Refused, never narrowed to the hub. A fallback here would hand back a
      // token that verifies perfectly at the hub and then 401s at the plane it
      // was asked for, with nothing to say why — which is the exact failure
      // this parameter exists to end, reintroduced one layer up.
      if (!client) {
        return c.json({ error: "this hub does not know that client" }, 400);
      }
      audiences = client.audiences;
    }

    const token = await signServiceToken({
      payload,
      subject: device.userId,
      ttl: TOKEN_TTL,
      amr: ["device"],
      audiences,
    });

    return c.json({
      token,
      expiresIn: 300,
      device: { id: device.id, name: device.name },
    });
  })

  /** Create a device credential. The secret in this response is the only copy. */
  .post("/devices", async (c) => {
    const caller = await resolveCaller(c);
    if (!caller) return c.json({ error: "unauthorized" }, 401);

    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name : "";

    const minted = await mintDeviceCredential({
      userId: caller.userId,
      tenantId: caller.tenantId,
      name,
    });

    return c.json(
      {
        id: minted.id,
        // Once. Not retrievable, not logged, not in the list below.
        secret: minted.secret,
        name: minted.name,
        expiresAt: minted.expiresAt.toISOString(),
      },
      201,
    );
  })

  /** This caller's devices — revoked ones included, so a list shows what it revoked. */
  .get("/devices", async (c) => {
    const caller = await resolveCaller(c);
    if (!caller) return c.json({ error: "unauthorized" }, 401);
    return c.json({ devices: await listDeviceCredentials(caller.userId) });
  })

  /**
   * Revoke one.
   *
   * 404 whether the device belongs to somebody else or does not exist — the
   * service scopes its UPDATE by `userId`, so this route cannot tell the two
   * apart even if it wanted to, which is the intended shape.
   */
  .delete("/devices/:id", async (c) => {
    const caller = await resolveCaller(c);
    if (!caller) return c.json({ error: "unauthorized" }, 401);

    const revoked = await revokeDeviceCredential(caller.userId, c.req.param("id"));
    if (!revoked) return c.json({ error: "no such live device" }, 404);
    return c.json({ revoked: true });
  });
}

/** The hub's own device routes, reading the hub's own registry. */
export const deviceRoutes = createDeviceRoutes();
