import { beforeAll, afterAll, test, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { db, rawSql } from "../db/drizzle";
import { skillArtifacts } from "../db/schema/skills";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser } from "../../tests/helpers/database";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import {
  storeSkillArtifact,
  listSkillArtifacts,
  getSkillArtifact,
  deleteSkillArtifact,
} from "./skill-artifacts";

const owner = {
  userId: `test-skill-artifacts-${crypto.randomUUID()}`,
  tenantId: BOOTSTRAP_TENANT_ID,
};
const metadata = { harness: "codex" as const, profile: "fixture" };
beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: owner.userId });
});
afterAll(async () => {
  await rawSql`DELETE FROM "user" WHERE id=${owner.userId}`;
});

test("artifact bytes round-trip privately, metadata contains no content, identical uploads are idempotent", async () => {
  const bytes = Buffer.from("synthetic immutable bytes");
  const a = await storeSkillArtifact(owner, metadata, bytes);
  const b = await storeSkillArtifact(owner, metadata, bytes);
  expect(a.id).toBe(b.id);
  expect(a.validation).toBe("unverified");
  expect((await getSkillArtifact(owner, a.id))?.bytes.equals(bytes)).toBe(true);
  expect(JSON.stringify(await listSkillArtifacts(owner))).not.toContain(
    "synthetic immutable bytes",
  );
  expect(
    await getSkillArtifact({ ...owner, userId: "other" }, a.id),
  ).toBeNull();
  expect(
    await getSkillArtifact(
      { ...owner, tenantId: "fleet_11111111111111111111" },
      a.id,
    ),
  ).toBeNull();
  expect(await listSkillArtifacts({ ...owner, userId: "other" })).toEqual([]);
  await expect(
    storeSkillArtifact(owner, { ...metadata, profile: "other" }, bytes),
  ).rejects.toThrow("metadata");
  expect(await deleteSkillArtifact({ ...owner, userId: "other" }, a.id)).toBe(
    false,
  );
  expect(await deleteSkillArtifact(owner, a.id)).toBe(true);
});

test("concurrent uploads cannot overrun the owner retention limit", async () => {
  await rawSql`INSERT INTO skill_artifacts (id,tenant_id,user_id,archive_sha256,harness,profile,size,bytes)
    SELECT gen_random_uuid()::text, ${owner.tenantId}, ${owner.userId}, lpad(to_hex(n),64,'0'), 'codex','fixture',1,decode('61','hex') FROM generate_series(1,255) AS n`;
  try {
    const outcomes = await Promise.allSettled([
      storeSkillArtifact(owner, metadata, Buffer.from("one")),
      storeSkillArtifact(owner, metadata, Buffer.from("two")),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await listSkillArtifacts(owner)).toHaveLength(256);
  } finally {
    await db
      .delete(skillArtifacts)
      .where(eq(skillArtifacts.userId, owner.userId));
  }
});
