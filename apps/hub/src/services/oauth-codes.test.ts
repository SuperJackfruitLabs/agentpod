/**
 * Service test: one-time authorization codes — mint + single-use redeem.
 *
 * A code travels in a URL bar, so everything here is about how little it is
 * worth: 60 seconds, one redemption, and only for the client and redirect URI
 * it was issued to. The redemption is a single conditional UPDATE, which is
 * the only reason the concurrency test at the bottom can pass — a
 * read-then-write would hand out a token to every racer.
 *
 * Uses the local Docker test-postgres (localhost:5434).
 * DATABASE_URL must be set before any src/ modules are imported.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db, rawSql } from "../db/drizzle";
import { oauthCodes } from "../db/schema/oauth";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { mintCode, redeemCode, CODE_TTL_MS } from "./oauth-codes";

const RUN = crypto.randomUUID().slice(0, 8);
const USER = `test-user-oauth-codes-${RUN}`;
const CLIENT = "kaambaan";
const REDIRECT = "https://kaambaan.dev/hub/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const minted: string[] = [];

/** Mint through the service, remembering the code so afterAll can clean up. */
async function mint(overrides: Partial<Parameters<typeof mintCode>[0]> = {}) {
  const result = await mintCode({
    clientId: CLIENT,
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    userId: USER,
    ...overrides,
  });
  minted.push(result.code);
  return result;
}

beforeAll(async () => {
  await ensurePgMigrations();
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM oauth_codes WHERE user_id = ${USER}`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Minting ──────────────────────────────────────────────────────────────────

test("mint returns an opaque code and an expiry one TTL away", async () => {
  const before = Date.now();
  const { code, expiresAt } = await mint();

  // 32 bytes base64url — no padding, no characters that need escaping in a
  // query string, since this rides back in a redirect URL.
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + CODE_TTL_MS - 1000);
  expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + CODE_TTL_MS + 1000);
});

test("the TTL is 60 seconds — a code lives only as long as a redirect takes", () => {
  expect(CODE_TTL_MS).toBe(60_000);
});

test("two mints never collide", async () => {
  const [a, b] = await Promise.all([mint(), mint()]);
  expect(a.code).not.toBe(b.code);
});

test("mint stores what the code was issued for", async () => {
  const { code } = await mint();
  const [row] = await db.select().from(oauthCodes).where(eq(oauthCodes.code, code));
  expect(row).toBeDefined();
  expect(row!.clientId).toBe(CLIENT);
  expect(row!.redirectUri).toBe(REDIRECT);
  expect(row!.codeChallenge).toBe(CHALLENGE);
  expect(row!.userId).toBe(USER);
  expect(row!.redeemedAt).toBeNull();
});

// ─── Redemption ───────────────────────────────────────────────────────────────

test("a freshly minted code redeems once, returning who authorized and the challenge", async () => {
  const { code } = await mint();
  expect(await redeemCode({ code, clientId: CLIENT, redirectUri: REDIRECT })).toEqual({
    userId: USER,
    codeChallenge: CHALLENGE,
  });
});

test("a second redemption returns null — a replay must not mint a second token", async () => {
  const { code } = await mint();
  expect(await redeemCode({ code, clientId: CLIENT, redirectUri: REDIRECT })).not.toBeNull();
  expect(await redeemCode({ code, clientId: CLIENT, redirectUri: REDIRECT })).toBeNull();
});

test("an expired code returns null", async () => {
  const { code } = await mint({ ttlMs: -1 });
  expect(await redeemCode({ code, clientId: CLIENT, redirectUri: REDIRECT })).toBeNull();
});

test("an unknown code returns null", async () => {
  expect(
    await redeemCode({ code: "no-such-code", clientId: CLIENT, redirectUri: REDIRECT })
  ).toBeNull();
});

test("a wrong clientId returns null and consumes nothing — it never matched", async () => {
  const { code } = await mint();
  expect(
    await redeemCode({ code, clientId: "supermessage", redirectUri: REDIRECT })
  ).toBeNull();

  // The code is still live for the client it WAS issued to. Consuming it here
  // would let anyone who learned the code burn someone else's redirect.
  expect(await redeemCode({ code, clientId: CLIENT, redirectUri: REDIRECT })).toEqual({
    userId: USER,
    codeChallenge: CHALLENGE,
  });
});

test("a wrong redirectUri returns null and consumes nothing", async () => {
  const { code } = await mint();
  expect(
    await redeemCode({ code, clientId: CLIENT, redirectUri: "https://evil.dev/hub/callback" })
  ).toBeNull();

  expect(await redeemCode({ code, clientId: CLIENT, redirectUri: REDIRECT })).toEqual({
    userId: USER,
    codeChallenge: CHALLENGE,
  });
});

// ─── The race that matters ────────────────────────────────────────────────────

test("25 concurrent redemptions of one code: exactly one wins", async () => {
  // The whole reason redeemCode is a single conditional UPDATE. Under
  // read-then-write every one of these reads `redeemed_at IS NULL` before any
  // of them writes, and 25 tokens come out of one authorization.
  const { code } = await mint();

  const results = await Promise.all(
    Array.from({ length: 25 }, () =>
      redeemCode({ code, clientId: CLIENT, redirectUri: REDIRECT })
    )
  );

  const winners = results.filter((r) => r !== null);
  expect(winners.length).toBe(1);
  expect(winners[0]).toEqual({ userId: USER, codeChallenge: CHALLENGE });
  expect(results.filter((r) => r === null).length).toBe(24);
});

// ─── Housekeeping ─────────────────────────────────────────────────────────────

test("minting sweeps codes long past any use, and never a live one", async () => {
  const { code: live } = await mint();

  const stale = `stale-${RUN}`;
  await db.insert(oauthCodes).values({
    code: stale,
    clientId: CLIENT,
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    userId: USER,
    expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  });

  await mint();

  const remaining = await db.select().from(oauthCodes).where(eq(oauthCodes.code, stale));
  expect(remaining).toEqual([]);
  expect(
    (await db.select().from(oauthCodes).where(eq(oauthCodes.code, live))).length
  ).toBe(1);
});
