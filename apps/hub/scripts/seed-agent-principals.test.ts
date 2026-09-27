/**
 * Proves the script is *invocable*, not just that `seedAgentPrincipals()`
 * works — those are different claims, and the gap between them was the whole
 * defect. The function has been well tested from day one (see
 * `../src/services/principals.test.ts`), which is exactly how a missing entry
 * point slipped through: `bun run scripts/seed-agent-principals.ts` used to
 * run, print nothing, and exit 0 without seeding a single station. A test
 * that only calls the exported function would still pass with no `main()` at
 * all — this spawns the real script as a subprocess, the way the runbook
 * does, and checks what an operator would actually see.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ensurePgMigrations } from "../tests/helpers/pg-migrations";

const HUB_ROOT = join(import.meta.dir, "..");

async function runScript(env: Record<string, string | undefined> = process.env) {
  const proc = Bun.spawn(["bun", "run", "scripts/seed-agent-principals.ts"], {
    cwd: HUB_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("scripts/seed-agent-principals.ts, run as a script", () => {
  // The script is spawned as its own process, so it finds whatever schema the
  // database already has — it does not build one. Every other integration suite
  // here migrates in `beforeAll`; this file did not, and so it passed only when
  // some other suite happened to migrate first. That is invisible on a
  // developer's machine, whose database was migrated weeks ago, and decided by
  // file ordering on a fresh CI database — where it failed, twice, while the
  // test asserting the script FAILS kept passing for the same reason.
  beforeAll(async () => {
    await ensurePgMigrations();
  });

  test("runs, seeds, and reports what it did", async () => {
    const { stdout, stderr, exitCode } = await runScript();

    expect(exitCode).toBe(0);
    // The defect was silence: a seed that prints nothing is indistinguishable
    // from a seed that did nothing. An operator reading this output must be
    // able to tell how many stations were seeded and how many were already
    // done.
    expect(stdout).toMatch(/seeded \d+/i);
    expect(stdout).toMatch(/skipped \d+/i);
    expect(stderr).not.toMatch(/error/i);
  });

  test("running it again reports everything already done — idempotent as a script, not just as a function", async () => {
    await runScript();
    const { stdout, exitCode } = await runScript();

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/seeded 0\b/i);
  });

  test("exits non-zero when it fails, so a runbook step can be trusted", async () => {
    const { exitCode } = await runScript({
      ...process.env,
      DATABASE_URL: "postgres://baduser:badpass@127.0.0.1:1/nonexistent",
    });

    expect(exitCode).not.toBe(0);
  });
});
