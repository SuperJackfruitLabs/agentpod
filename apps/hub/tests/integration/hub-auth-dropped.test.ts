process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { beforeAll, describe, expect, test } from "bun:test";
import { rawSql } from "../../src/db/drizzle";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { readOrgPlaneConfig } from "../../src/auth/org-plane/config";

/**
 * P3 plan Task 17: after the rollback window (P4 + 7 days) the hub's own issuer and principal
 * tables go, and the org plane is the only mode there is.
 */
const DROPPED = [
  "user", "session", "account", "verification", "jwks",
  "principals", "principal_identities", "principal_grants", "organizations",
  "device_credentials", "service_credentials", "service_signing_keys", "oauth_codes",
];
const KEPT = ["legacy_user_principals", "hub_operators", "tenants", "nodes", "stations"];

beforeAll(ensurePgMigrations);

describe("after the rollback window", () => {
  test("the hub's auth and principal tables are gone; the cutover's own tables remain", async () => {
    const rows = await rawSql<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`;
    const tables = new Set(rows.map((r) => r.t));
    expect(DROPPED.filter((t) => tables.has(t))).toEqual([]);
    expect(KEPT.filter((t) => !tables.has(t))).toEqual([]);
  });

  test("no foreign key points at a dropped table", async () => {
    const rows = await rawSql`
      SELECT conname FROM pg_constraint WHERE contype = 'f' AND confrelid::regclass::text = ANY(${DROPPED.map((t) => `"${t}"`).concat(DROPPED)})`;
    expect(rows).toHaveLength(0);
  });

  test("the hub holds no signing key (design §9)", async () => {
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(new URL("../../src/auth/", import.meta.url))).not.toContain("service-signing.ts");
  });

  test("ORG_PLANE_* is now required", () => {
    expect(readOrgPlaneConfig({}).ok).toBe(false);
  });
});

