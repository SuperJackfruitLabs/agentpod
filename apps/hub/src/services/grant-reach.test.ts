/**
 * Service Test: grant-reach — growing the fleet is an admin act
 *
 * Uses the local Docker test-postgres (localhost:5434).
 * DATABASE_URL must be set before any src/ modules are imported.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser } from "../../tests/helpers/database";
import { rawSql } from "../db/drizzle";
import { createPrincipal } from "./principals";
import { requireFleetGrantReach } from "./grant-reach";
import { GrantReachDenied, isControlPairEnforced } from "./control-pair";

const NON_ADMIN_USER = "test-user-grant-reach-nonadmin";
const ADMIN_USER = "test-user-grant-reach-admin";

let NON_ADMIN_PRINCIPAL: string;
let ADMIN_PRINCIPAL: string;

beforeAll(async () => {
  await ensurePgMigrations();

  await createTestUser({
    id: NON_ADMIN_USER,
    email: "grant-reach-nonadmin@example.com",
    name: "Non Admin",
    role: "user",
  });
  await createTestUser({
    id: ADMIN_USER,
    email: "grant-reach-admin@example.com",
    name: "Admin",
    role: "admin",
  });

  NON_ADMIN_PRINCIPAL = await createPrincipal({
    kind: "human",
    handle: "grant-reach-nonadmin",
    userId: NON_ADMIN_USER,
  });
  ADMIN_PRINCIPAL = await createPrincipal({
    kind: "human",
    handle: "grant-reach-admin",
    userId: ADMIN_USER,
  });

  // The guard is a no-op unless the control pair is enforced.
  process.env.ENFORCE_CONTROL_PAIR = "true";
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM principal_identities WHERE external_id IN (${NON_ADMIN_USER}, ${ADMIN_USER})`;
    await rawSql`DELETE FROM principals WHERE handle IN ('grant-reach-nonadmin', 'grant-reach-admin')`;
    await rawSql`DELETE FROM "user" WHERE id IN (${NON_ADMIN_USER}, ${ADMIN_USER})`;
  } catch {
    // cleanup only
  }
});

describe("requireFleetGrantReach", () => {
  test("a non-admin cannot mint an enrollment token, however wide their grant", async () => {
    // The wildcard that encoded "your authority spans the fleet" no longer
    // exists. A second scoped list was rejected by
    // 2026-08-15-granting-reach-is-changing-an-agent, so this is admin.
    await expect(requireFleetGrantReach(NON_ADMIN_PRINCIPAL)).rejects.toThrow(GrantReachDenied);
  });

  test("an admin may", async () => {
    await expect(requireFleetGrantReach(ADMIN_PRINCIPAL)).resolves.toBeUndefined();
  });

  test("is a no-op when the pair is not enforced, admin or not", async () => {
    const before = process.env.ENFORCE_CONTROL_PAIR;
    expect(isControlPairEnforced()).toBe(true);
    try {
      process.env.ENFORCE_CONTROL_PAIR = "false";
      await expect(requireFleetGrantReach(NON_ADMIN_PRINCIPAL)).resolves.toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.ENFORCE_CONTROL_PAIR;
      else process.env.ENFORCE_CONTROL_PAIR = before;
    }
  });
});
