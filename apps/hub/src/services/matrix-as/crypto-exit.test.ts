import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";

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

const HUB = join(import.meta.dir, "..", "..", "..");
const SCRIPT = join(import.meta.dir, "testdata", "exit-with-open-machine.ts");
const TEST_FILE = join(import.meta.dir, "testdata", "open-machine.bun-test-fixture.ts");

async function run(argv: string[]) {
  // From the hub's root, so its bunfig.toml — and the preload in it — applies
  // exactly as it does to the hub's own `bun test`.
  const proc = Bun.spawn([process.execPath, ...argv], { cwd: HUB, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
}

describe("exiting with an open crypto machine", () => {
  test("when the event loop drains", async () => {
    const { exitCode, output } = await run([SCRIPT, "natural"]);
    expect(output).not.toContain("panicked");
    expect(exitCode).toBe(0);
  }, 30_000);

  test("when the process calls process.exit", async () => {
    const { exitCode, output } = await run([SCRIPT, "exit"]);
    expect(output).not.toContain("panicked");
    expect(exitCode).toBe(0);
  }, 30_000);

  // The path that actually failed CI. bun test runs no `exit` listeners, so
  // only the preload's global afterAll stands between an unclosed machine and
  // SIGABRT here.
  test("when bun test exits", async () => {
    const { exitCode, output } = await run(["test", `./${relative(HUB, TEST_FILE)}`]);
    expect(output).toContain("1 pass");
    expect(output).not.toContain("panicked");
    expect(exitCode).toBe(0);
  }, 30_000);
});
