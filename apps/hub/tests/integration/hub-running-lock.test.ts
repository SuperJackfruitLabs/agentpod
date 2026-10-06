/**
 * The hub holds a session-level advisory lock for as long as it runs, so the cutover script
 * (scripts/rewrite-user-ids.ts) can tell that a hub is using the database and refuse (security
 * review finding 4). Shared, so two hubs on one database (a rolling deploy) do not lock each
 * other out; the script asks for it exclusively.
 */
import { afterAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HUB_RUNNING_LOCK, holdHubRunningLock } from "../../src/db/hub-running-lock";

const URL_ = process.env.DATABASE_URL ?? "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
const quiet = { onnotice: () => {} };
const probe = postgres(URL_, { max: 1, ...quiet });

async function exclusiveAvailable(): Promise<boolean> {
  const [r] = await probe<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(${HUB_RUNNING_LOCK.classid}, ${HUB_RUNNING_LOCK.objid}) AS ok`;
  if (r!.ok) await probe`SELECT pg_advisory_unlock(${HUB_RUNNING_LOCK.classid}, ${HUB_RUNNING_LOCK.objid})`;
  return r!.ok;
}

afterAll(async () => {
  await probe.end();
});

describe("the hub-running lock", () => {
  test("while held, nobody can take it exclusively; once released, they can", async () => {
    expect(await exclusiveAvailable()).toBe(true);
    const held = await holdHubRunningLock(URL_);
    try {
      expect(await exclusiveAvailable()).toBe(false);
    } finally {
      await held.release();
    }
    expect(await exclusiveAvailable()).toBe(true);
  });

  test("two hubs can hold it at once (a rolling deploy is not a conflict)", async () => {
    const a = await holdHubRunningLock(URL_);
    const b = await holdHubRunningLock(URL_);
    try {
      expect(await exclusiveAvailable()).toBe(false);
      await a.release();
      expect(await exclusiveAvailable()).toBe(false); // b still holds it
    } finally {
      await b.release();
    }
    expect(await exclusiveAvailable()).toBe(true);
  });

  test("a hub refuses to boot while a maintenance script holds the lock", async () => {
    await probe`SELECT pg_advisory_lock(${HUB_RUNNING_LOCK.classid}, ${HUB_RUNNING_LOCK.objid})`;
    try {
      const err = await holdHubRunningLock(URL_).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err)).toContain("maintenance");
    } finally {
      await probe`SELECT pg_advisory_unlock(${HUB_RUNNING_LOCK.classid}, ${HUB_RUNNING_LOCK.objid})`;
    }
  });

  test("the hub takes it at boot, before migrations run", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "index.ts"), "utf8");
    const lock = src.indexOf("await holdHubRunningLock(");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(src.indexOf("await initDatabase()"));
  });
});
