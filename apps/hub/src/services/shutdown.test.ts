import { describe, expect, test } from "bun:test";
import { createGracefulShutdown } from "./shutdown";

describe("graceful hub shutdown", () => {
  test("stops background work and closes Matrix crypto before exiting", async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({
      stopSweeper: () => calls.push("sweeper"),
      stopBridge: async () => { calls.push("bridge"); },
      closeMatrixBridge: async () => { calls.push("matrix"); },
      exit: (code) => calls.push(`exit:${code}`),
      log: (message) => calls.push(message),
    });

    await shutdown("SIGTERM");

    expect(calls).toEqual([
      "Shutting down (SIGTERM)...",
      "sweeper",
      "bridge",
      "matrix",
      "exit:0",
    ]);
  });

  test("shares one shutdown when more than one signal arrives", async () => {
    let releases: (() => void) | undefined;
    let started: (() => void) | undefined;
    const bridgeStarted = new Promise<void>((resolve) => { started = resolve; });
    let stops = 0;
    const shutdown = createGracefulShutdown({
      stopSweeper: () => { stops += 1; },
      stopBridge: () => new Promise<void>((resolve) => { releases = resolve; started!(); }),
      exit: () => undefined,
    });

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");
    expect(first).toBe(second);
    await bridgeStarted;
    expect(stops).toBe(1);

    releases!();
    await first;
  });

  test("still closes Matrix crypto if another cleanup step fails", async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({
      stopSweeper: () => calls.push("sweeper"),
      stopBridge: async () => { throw new Error("board unavailable"); },
      closeMatrixBridge: async () => { calls.push("matrix"); },
      exit: (code) => calls.push(`exit:${code}`),
      log: (message) => calls.push(message),
    });

    await shutdown("SIGTERM");

    expect(calls).toContain("matrix");
    expect(calls).toContain("exit:1");
  });
});
