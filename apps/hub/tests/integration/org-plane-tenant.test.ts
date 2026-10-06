process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { tenantForOrg } from "../../src/auth/org-plane/tenant";

const hex = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const created: string[] = [];

beforeAll(ensurePgMigrations);
afterAll(async () => {
  if (created.length) await db.delete(tenants).where(inArray(tenants.externalId, created));
});

describe("tenantForOrg", () => {
  test("first sight creates one tenant mapped to the org; the second sight reuses it", async () => {
    const org = `org_${hex()}`;
    created.push(org);
    const a = await tenantForOrg({ org, ent: ["agentpod"] });
    const b = await tenantForOrg({ org, ent: ["agentpod", "superpipeline"] });
    expect(a.ok && b.ok && a.tenantId === b.tenantId).toBe(true);
    const rows = await db
      .select()
      .from(tenants)
      .where(and(eq(tenants.externalSource, "org-plane"), eq(tenants.externalId, org)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toMatch(/^fleet_[0-9a-f]{20}$/);
  });

  test("ent without agentpod is 403 product_not_enabled naming the org, and creates nothing", async () => {
    const org = `org_${hex()}`;
    created.push(org);
    const r = await tenantForOrg({ org, ent: ["superpipeline"] });
    expect(r).toEqual({ ok: false, status: 403, body: { error: "product_not_enabled", org } });
    const rows = await db.select().from(tenants).where(eq(tenants.externalId, org));
    expect(rows).toHaveLength(0);
  });

  test("concurrent first sights converge on one tenant", async () => {
    const org = `org_${hex()}`;
    created.push(org);
    const results = await Promise.all(Array.from({ length: 5 }, () => tenantForOrg({ org, ent: ["agentpod"] })));
    const ids = new Set(results.map((r) => (r.ok ? r.tenantId : "refused")));
    expect(ids.size).toBe(1);
  });
});
