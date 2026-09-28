import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * A process must be able to exit with an agent crypto machine still open
 * (issue #457).
 *
 * The explicit `close()` in the hub's shutdown handler covers one exit path.
 * Everything else — a test that forgot to close, an uncaught error, bun test's
 * own exit — used to end in SIGABRT from inside napi-rs, and a CI run whose
 * every test had passed went red. These run a real process, because the
 * failure is in how that process dies, which no in-process assertion can see.
 */

const FIXTURE = join(import.meta.dir, "testdata", "exit-with-open-machine.ts");

async function runFixture(mode: "natural" | "exit") {
  const proc = Bun.spawn([process.execPath, FIXTURE, mode], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { exitCode, stderr };
}

describe("exiting with an open crypto machine", () => {
  test("when the event loop drains", async () => {
    const { exitCode, stderr } = await runFixture("natural");
    expect(stderr).not.toContain("panicked");
    expect(exitCode).toBe(0);
  }, 30_000);

  test("when the process calls process.exit", async () => {
    const { exitCode, stderr } = await runFixture("exit");
    expect(stderr).not.toContain("panicked");
    expect(exitCode).toBe(0);
  }, 30_000);
});
