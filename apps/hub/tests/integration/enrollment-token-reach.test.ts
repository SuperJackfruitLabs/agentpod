import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { setGrant } from "../../src/services/grants";
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
 * nothing to match against. The rule here is narrower instead: you may grow a
 * fleet only if your authority already spans it.
 */

const USER = "test-user-enroll-reach";

function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: USER, role: "user" });
    await next();
  });
  a.route("/", enrollmentTokenRoutes);
  return a;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "enroll-reach@example.com", name: "ER" });
  process.env.ENFORCE_CONTROL_PAIR = "true";
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${USER}`;
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${USER}`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

describe("growing the fleet requires fleet-wide authority", () => {
  test("refused for a node-scoped principal", async () => {
    // Their grant describes one machine. A machine they add is one it never
    // described — and on a wildcard-free grant they could keep adding them.
    await setGrant(USER, { mayDispatch: ["agentpod:one-box/hermes:*"], mayGrantReach: true });

    const res = await app().request("/", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/add machines/i);
  });

  test("permitted when the principal's authority already spans the fleet", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: true });

    const res = await app().request("/", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token: string }).token).toBeTruthy();
  });

  test("refused without the boolean, however wide the scope", async () => {
    await setGrant(USER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });
    expect((await app().request("/", { method: "POST" })).status).toBe(403);
  });

  test("refused for a principal with no grant at all", async () => {
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${USER}`;
    expect((await app().request("/", { method: "POST" })).status).toBe(403);
  });

  test("is a no-op when the pair is not enforced", async () => {
    // A deployment that has not switched the pair on must enrol exactly as it
    // did before — this control ships live, so its off-state has to be silent.
    const before = process.env.ENFORCE_CONTROL_PAIR;
    try {
      process.env.ENFORCE_CONTROL_PAIR = "false";
      await rawSql`DELETE FROM principal_grants WHERE principal_id = ${USER}`;

      const res = await app().request("/", { method: "POST" });
      expect(res.status).toBe(200);
    } finally {
      if (before === undefined) delete process.env.ENFORCE_CONTROL_PAIR;
      else process.env.ENFORCE_CONTROL_PAIR = before;
    }
  });
});
