import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { setGrant } from "../../src/services/grants";
import { createPrincipal } from "../../src/services/principals";
import { enrollmentTokenRoutes } from "../../src/routes/enrollment-tokens";

/**
 * Minting an enrollment token is granting reach.
 *
 * Decision 4 states the threat as "anyone who can **register an agent** and
 * grant it production credentials … they build the agent they want." A machine
 * joining the fleet is that registration, and it arrives carrying whatever the
 * person who added it put on it.
 *
 * It names no station, so the composition rule the station routes use has
 * nothing to match against. The rule here is admin, full stop — see
 * `services/grant-reach.ts`'s `requireFleetGrantReach` for why a wildcard
 * dispatch grant can no longer say "spans the fleet".
 */

const USER = "test-user-enroll-reach";
const ADMIN_USER = "test-user-enroll-reach-admin";

let USER_PRINCIPAL: string;

function app(userId: string) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: userId, role: "user" });
    await next();
  });
  a.route("/", enrollmentTokenRoutes);
  return a;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "enroll-reach@example.com", name: "ER" });
  await createTestUser({
    id: ADMIN_USER,
    email: "enroll-reach-admin@example.com",
    name: "ER Admin",
    role: "admin",
  });
  USER_PRINCIPAL = await createPrincipal({ kind: "human", handle: "enroll-reach-user", userId: USER });
  await createPrincipal({ kind: "human", handle: "enroll-reach-admin", userId: ADMIN_USER });
  process.env.ENFORCE_CONTROL_PAIR = "true";
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id IN (${USER}, ${ADMIN_USER})`;
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${USER_PRINCIPAL}`;
    await rawSql`DELETE FROM principal_identities WHERE external_id IN (${USER}, ${ADMIN_USER})`;
    await rawSql`DELETE FROM principals WHERE handle IN ('enroll-reach-user', 'enroll-reach-admin')`;
    await rawSql`DELETE FROM "user" WHERE id IN (${USER}, ${ADMIN_USER})`;
  } catch {
    // cleanup only
  }
});

describe("growing the fleet is an admin act", () => {
  test("an admin may mint an enrollment token", async () => {
    const res = await app(ADMIN_USER).request("/", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token: string }).token).toBeTruthy();
  });

  test("a non-admin may not, however permissive their grant", async () => {
    // This is the exact case the wildcard used to permit: a dispatch pattern
    // spanning every node, plus mayGrantReach. It used to be sufficient on its
    // own. It no longer is — admin is the only thing that answers now, and
    // there is no wildcard left to spell "every node" with anyway.
    await setGrant(USER_PRINCIPAL, { mayDispatch: ["prn_ffffffffffffffffffff"], mayGrantReach: true });

    const res = await app(USER).request("/", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/add machines/i);
  });

  test("is a no-op when the pair is not enforced", async () => {
    // A deployment that has not switched the pair on must enrol exactly as it
    // did before — this control ships live, so its off-state has to be silent.
    const before = process.env.ENFORCE_CONTROL_PAIR;
    try {
      process.env.ENFORCE_CONTROL_PAIR = "false";

      const res = await app(USER).request("/", { method: "POST" });
      expect(res.status).toBe(200);
    } finally {
      if (before === undefined) delete process.env.ENFORCE_CONTROL_PAIR;
      else process.env.ENFORCE_CONTROL_PAIR = before;
    }
  });
});
