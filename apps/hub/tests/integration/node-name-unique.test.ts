import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";

/**
 * A node name identifies one machine.
 *
 * It did not have to before: a name was a label, and `hostname` supplied it
 * unaltered. It has to now, because a grant names a node —
 * `agentpod:<node>/<stationKey>` — and an ambiguous name is an ambiguous
 * permission, which would let a grant written for a staging box silently cover
 * production.
 *
 * Two machines sharing a hostname is ordinary rather than exotic: Fly machines
 * from one image, containers, laptops called `localhost`.
 */

const USER = "test-user-nodename";

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "nodename@example.com", name: "NN" });
  // Start from a clean slate: this file asserts on the exact suffix sequence, so
  // rows left by an interrupted run would make the first enrolment land on
  // `collide-host-4` and read as a bug in the naming.
  await rawSql`DELETE FROM nodes WHERE user_id = ${USER}`;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM nodes WHERE user_id = ${USER}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${USER}`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

async function enroll(hostname: string) {
  const { token } = await mintEnrollmentToken(USER);
  return enrollNode(token, { hostname, os: "linux", arch: "amd64", cpuCount: 2 });
}

describe("node names are unique within a tenant", () => {
  test("the first machine keeps its hostname", async () => {
    const { nodeId } = await enroll("collide-host");
    const [row] = await rawSql`SELECT name, hostname FROM nodes WHERE id = ${nodeId}`;
    expect(row!.name).toBe("collide-host");
    expect(row!.hostname).toBe("collide-host");
  });

  test("a second machine with the same hostname gets a suffix", async () => {
    const { nodeId } = await enroll("collide-host");
    const [row] = await rawSql`SELECT name, hostname FROM nodes WHERE id = ${nodeId}`;

    expect(row!.name).toBe("collide-host-2");
    // The machine's own answer about itself is untouched — only the name this
    // fleet calls it by is disambiguated.
    expect(row!.hostname).toBe("collide-host");
  });

  test("and a third keeps counting", async () => {
    const { nodeId } = await enroll("collide-host");
    const [row] = await rawSql`SELECT name FROM nodes WHERE id = ${nodeId}`;
    expect(row!.name).toBe("collide-host-3");
  });

  test("a suffix is numeric rather than a hash, because a person reads it", async () => {
    // `molt-bot-2` tells you which machine you are granting. `molt-bot-a3f9c1`
    // does not, and a grant nobody can read is a grant nobody checks.
    const [row] = await rawSql`
      SELECT name FROM nodes WHERE user_id = ${USER} AND name LIKE 'collide-host-%' ORDER BY name LIMIT 1`;
    expect(row!.name).toMatch(/^collide-host-\d+$/);
  });

  test("the database refuses a duplicate even if the service is bypassed", async () => {
    // The loop makes the common case readable; the constraint is the guarantee.
    // A race that slips past the check must fail loudly rather than produce two
    // machines a grant cannot tell apart.
    //
    // Caught explicitly rather than through `expect(...).rejects`: a rejected
    // query left the pool holding an errored connection and the runner never
    // exited, which reads as a hung suite rather than a failing test.
    const [existing] = await rawSql`
      SELECT tenant_id, name FROM nodes WHERE user_id = ${USER} LIMIT 1`;

    let refused: unknown = null;
    try {
      await rawSql`
        INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
        VALUES ('node_dupe_test', ${existing!.tenant_id}, ${USER}, ${existing!.name},
                'collide-host', 'linux', 'amd64', 2, 'offline', 'x', now())`;
    } catch (e) {
      refused = e;
    }

    expect(refused).not.toBeNull();
    expect(String(refused)).toMatch(/unique|duplicate/i);
  });
});
