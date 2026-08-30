/**
 * Minting a token that asserts someone who is not here.
 *
 * Everything else this hub signs is a token for the caller: they signed in,
 * they hold a session, `GET /api/auth/token` hands them a short-lived
 * assertion of the identity they just proved. This module does the other thing,
 * and it exists for exactly one reason —
 * `charter → decisions/2026-08-14-approvals-cross-planes-as-events.md` requires
 * a human's approval to reach kaambaan **as that human**, and the human is not
 * present: they are a Matrix message and a `principal_identities` row.
 *
 * ## The two properties that make this safe to have at all
 *
 * **The subject is never a parameter.** `mintPrincipalAssertion` takes a
 * principal id that its caller obtained by looking up a *sender's* mxid in
 * `principal_identities`. There is no path where a caller names whom it would
 * like to be. That is the whole control; everything below is defence in depth.
 *
 * **It says it is doing it.** The token carries `act` — RFC 8693's actor claim
 * — naming the service that minted it, while `sub` stays the human. A consumer
 * can therefore tell "Rakesh approved this" from "the bridge approved this on
 * Rakesh's behalf", which are different facts and were previously
 * indistinguishable. Delegation that cannot be seen in the record is
 * impersonation with better manners.
 *
 * ## Why a separate key
 *
 * Not cryptography — both key sets are published together and verify
 * identically. It is so the two authorities can be revoked separately: deleting
 * this key stops the bridge speaking for anyone and signs nobody out of the
 * console. See migration 0054 for why it is not simply another `jwks` row.
 */

import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { and, desc, eq, isNull } from "drizzle-orm";

import { config } from "../config";
import { db } from "../db/drizzle";
import { serviceSigningKeys } from "../db/schema/service-keys";
import { buildTokenPayload } from "./jwt-claims";
import { createLogger } from "../utils/logger";

const log = createLogger("service-signing");

/**
 * Short, because it is used immediately and once.
 *
 * A session token's lifetime is a convenience for a person clicking around. This
 * one exists to survive a single HTTP call to kaambaan, so anything longer is
 * just a wider window for a leaked token to be replayed in.
 */
const ASSERTION_TTL = "120s";

/** Matches Better Auth's `jwt` plugin, and what kaambaan pins. */
const ALG = "EdDSA";

/** Who is doing the asserting. Ends up in `act.sub`. */
export const BRIDGE_ACTOR = "agentpod:matrix-application-service";

interface StoredKey {
  kid: string;
  privateJwk: JWK;
}

/**
 * The key to sign with, creating one on first use.
 *
 * Created lazily rather than in a migration because a migration cannot generate
 * a keypair, and seeding one from the environment would put it in a place this
 * repository forbids secrets from living.
 */
async function activeKey(): Promise<StoredKey> {
  const [row] = await db
    .select({ kid: serviceSigningKeys.kid, privateJwk: serviceSigningKeys.privateJwk })
    .from(serviceSigningKeys)
    .where(isNull(serviceSigningKeys.retiredAt))
    .orderBy(desc(serviceSigningKeys.createdAt))
    .limit(1);

  if (row) return { kid: row.kid, privateJwk: JSON.parse(row.privateJwk) as JWK };

  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  const kid = `svc-${crypto.randomUUID()}`;
  const publicJwk = { ...(await exportJWK(publicKey)), alg: ALG, kid, use: "sig" };
  const privateJwk = { ...(await exportJWK(privateKey)), alg: ALG, kid };

  await db.insert(serviceSigningKeys).values({
    kid,
    publicJwk: JSON.stringify(publicJwk),
    privateJwk: JSON.stringify(privateJwk),
  });
  log.info("minted a service signing key", { kid });

  return { kid, privateJwk };
}

/**
 * Every service key's PUBLIC half, retired ones included.
 *
 * Retired keys stay published because tokens they signed are still valid until
 * they expire. Removing a key is not a revocation lever — a consumer keeps
 * verifying against its cached JWKS regardless, which is the sharp edge #331
 * measured on the other key set.
 */
export async function servicePublicJwks(): Promise<JWK[]> {
  const rows = await db
    .select({ publicJwk: serviceSigningKeys.publicJwk })
    .from(serviceSigningKeys);
  return rows.map((r) => JSON.parse(r.publicJwk) as JWK);
}

export interface AssertionInput {
  /**
   * The principal being asserted.
   *
   * **Must** have come from `principal_identities` — a record of sameness minted
   * by an explicit link, never inferred from a localpart or a matching email.
   * Passing anything a caller supplied makes this an impersonation endpoint.
   */
  principalId: string;
  /** The service doing the asserting. Defaults to the bridge. */
  actor?: string;
}

/**
 * A short-lived token whose `sub` is a human and whose `act.sub` is this service.
 *
 * The claims are built by the same `buildTokenPayload` a session token uses, so
 * `tenant`, `mayDispatch` and `mayGrantReach` mean exactly what they mean
 * everywhere else and stay pinned by the shared fixture. This adds `act` and
 * nothing else — an assertion must not be able to carry authority a person's own
 * token would not.
 */
export async function mintPrincipalAssertion(input: AssertionInput): Promise<string> {
  const payload = await buildTokenPayload({ principalId: input.principalId });
  const key = await activeKey();
  const privateKey = await importJWK(key.privateJwk, ALG);

  return new SignJWT({
    ...payload,
    act: { sub: input.actor ?? BRIDGE_ACTOR },
  })
    .setProtectedHeader({ alg: ALG, kid: key.kid })
    .setSubject(input.principalId)
    .setIssuedAt()
    .setIssuer(config.publicUrl)
    .setAudience(config.publicUrl)
    .setExpirationTime(ASSERTION_TTL)
    .sign(privateKey);
}
