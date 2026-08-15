import { beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { rawSql } from "../../src/db/drizzle";
import { auth } from "../../src/auth/drizzle-auth";

/**
 * The issuer's two endpoints, against a real migrated database.
 *
 * The unit tests cover the claim contract; these cover the thing a unit test
 * cannot: that there is storage behind the plugin. It was wired up with no
 * `jwks` table, which typechecks, passes every unit test, and 500s the first
 * time a caller asks for a token — the same shape as a capability advertised
 * because a binary happened to resolve.
 */
describe("the issuer's endpoints (#332)", () => {
  beforeAll(async () => {
    await ensurePgMigrations();
  });

  test("the jwks table exists after migrations", async () => {
    const rows = await rawSql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'jwks'
    `;
    const columns = rows.map((r: { column_name: string }) => r.column_name).sort();

    // Better Auth's own column names, camelCase and quoted. Renaming them to
    // this schema's snake_case house style would look tidier and break the
    // plugin's adapter at runtime.
    expect(columns).toContain("publicKey");
    expect(columns).toContain("privateKey");
    expect(columns).toContain("createdAt");
  });

  test("GET /api/auth/jwks answers, and publishes only public material", async () => {
    const res = await auth.handler(
      new Request("http://localhost:3001/api/auth/jwks")
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(Array.isArray(body.keys)).toBe(true);

    for (const key of body.keys) {
      // `d` is the private scalar of an OKP/EC key. Publishing it would hand
      // every verifier the ability to mint tokens.
      expect(key, "a JWKS must never carry private material").not.toHaveProperty("d");
      expect(key).toHaveProperty("kid");
    }
  });

  test("a consumer that asks first, before any token exists, still gets a key", async () => {
    // The bootstrap order a consumer actually meets, and the reason this test
    // wipes the table first: without that, it passes for the wrong reason,
    // because the test above already caused a key to exist.
    //
    // What is being established: kaambaan caches this set on its first verify.
    // If the hub minted a signing key only when someone asked for a *token*, a
    // consumer that started first would cache an EMPTY set and reject every
    // token until that cache expired — indistinguishable, from the consumer's
    // side, from the tokens being invalid.
    //
    // It does not: /jwks mints the first key itself. So no "warm the issuer
    // before pointing a consumer at it" step is needed in the runbook.
    await rawSql`DELETE FROM jwks`;
    expect((await rawSql`SELECT count(*)::int AS n FROM jwks`)[0]!.n).toBe(0);

    const res = await auth.handler(
      new Request("http://localhost:3001/api/auth/jwks")
    );
    const body = (await res.json()) as { keys: unknown[] };

    expect(body.keys.length).toBeGreaterThan(0);
    expect((await rawSql`SELECT count(*)::int AS n FROM jwks`)[0]!.n).toBe(1);
  });
});
