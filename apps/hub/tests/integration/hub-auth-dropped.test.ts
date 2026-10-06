process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
const KEPT = ["legacy_user_principals", "hub_operators", "human_matrix_ids", "tenants", "nodes", "stations"];

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

/**
 * Deviation from the plan (recorded in the commit): the plane resolves Matrix id → principal but
 * has no read the other way, which the hub asks every time it invites a person to their agent's
 * room. 0095 therefore keeps the humans' `matrix` rows of `principal_identities` as
 * `human_matrix_ids` before dropping it. Proven on the file's own statement, against stand-in
 * tables inside a transaction that is rolled back.
 */
describe("0095 keeps each person's Matrix id before dropping principal_identities", () => {
  const seed = readFileSync(join(import.meta.dir, "../../src/db/drizzle-migrations/0095_drop_hub_auth.sql"), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim())
    .find((s) => s.startsWith("DO $$"));

  test("humans' matrix links are copied; agents' and other systems' are not; a re-run changes nothing", async () => {
    expect(seed).toBeTruthy();
    const rolledBack = new Error("rollback");
    const seen = await rawSql
      .begin(async (tx) => {
        await tx`CREATE TABLE principals (id text PRIMARY KEY, kind text NOT NULL)`;
        await tx`CREATE TABLE principal_identities (principal_id text, system text, external_id text)`;
        await tx`INSERT INTO principals VALUES ('prn_aaaaaaaaaaaaaaaaaaaa', 'human'), ('prn_bbbbbbbbbbbbbbbbbbbb', 'agent'), ('prn_cccccccccccccccccccc', 'human')`;
        await tx`INSERT INTO principal_identities VALUES
          ('prn_aaaaaaaaaaaaaaaaaaaa', 'matrix', '@alice:id.test'),
          ('prn_bbbbbbbbbbbbbbbbbbbb', 'matrix', '@agent_b:id.test'),
          ('prn_cccccccccccccccccccc', 'better-auth', 'user-c')`;
        await tx.unsafe(seed!);
        await tx.unsafe(seed!);
        const rows = await tx<{ principal_id: string; matrix_id: string }[]>`
          SELECT principal_id, matrix_id FROM human_matrix_ids
          WHERE principal_id IN ('prn_aaaaaaaaaaaaaaaaaaaa', 'prn_bbbbbbbbbbbbbbbbbbbb', 'prn_cccccccccccccccccccc')`;
        throw Object.assign(rolledBack, { rows: [...rows] });
      })
      .catch((e) => (e === rolledBack ? (e as Error & { rows: unknown[] }).rows : Promise.reject(e)));
    expect(seen).toEqual([{ principal_id: "prn_aaaaaaaaaaaaaaaaaaaa", matrix_id: "@alice:id.test" }]);
  });

  test("with principal_identities already gone (a fresh database), the seed is a no-op", async () => {
    await rawSql.unsafe(seed!);
  });
});
