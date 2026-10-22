import { beforeAll, afterAll, test, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { db, rawSql } from "../db/drizzle";
import { skillArtifacts } from "../db/schema/skills";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser, deleteTestUser } from "../../tests/helpers/database";
import { tenantForOrg } from "../auth/org-plane/tenant";
import {
  storeSkillArtifact,
  listSkillArtifacts,
  getSkillArtifact,
  deleteSkillArtifact,
} from "./skill-artifacts";

// A workspace of its own: artifacts, their dedupe and their quota are the workspace's (W4), so a
// shared tenant's other rows would count against this file's limit.
const owner = {
  userId: `test-skill-artifacts-${crypto.randomUUID()}`,
  tenantId: "",
};
const metadata = { harness: "codex" as const, profile: "fixture" };
beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: owner.userId });
  const t = await tenantForOrg({ org: "org_88888888888888888888", ent: ["agentpod"] });
  if (!t.ok) throw new Error("tenant resolution refused");
  owner.tenantId = t.tenantId;
  await rawSql`DELETE FROM skill_artifacts WHERE tenant_id = ${owner.tenantId}`;
});
afterAll(async () => {
  await deleteTestUser(owner.userId);
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
  // Another member of the workspace reads it; another workspace does not (W4).
  expect(
    (await getSkillArtifact({ ...owner, userId: "other" }, a.id))?.id,
  ).toBe(a.id);
  expect(
    await getSkillArtifact(
      { ...owner, tenantId: "fleet_11111111111111111111" },
      a.id,
    ),
  ).toBeNull();
  expect((await listSkillArtifacts({ ...owner, userId: "other" })).map((x) => x.id)).toEqual([a.id]);
  expect(await listSkillArtifacts({ ...owner, tenantId: "fleet_11111111111111111111" })).toEqual([]);
  await expect(
    storeSkillArtifact(owner, { ...metadata, profile: "other" }, bytes),
  ).rejects.toThrow("metadata");
  expect(await deleteSkillArtifact({ ...owner, tenantId: "fleet_11111111111111111111" }, a.id)).toBe(
    false,
  );
  expect(await deleteSkillArtifact({ ...owner, userId: "other" }, a.id)).toBe(true);
});

test("concurrent uploads cannot overrun the workspace retention limit", async () => {
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
