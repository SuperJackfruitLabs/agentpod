/**
 * Round-trip test: snapshot-wrapper.sh.
 *
 * This is the test that would have caught the actual defect. It runs the real
 * wrapper script against a real HTTP endpoint and a real temp filesystem, then
 * asserts the thing the user cares about: a file written into the workspace is
 * still there after the container has been stopped and started again.
 *
 * No Docker — the wrapper takes its filesystem root from AGENTPOD_SNAPSHOT_ROOT
 * precisely so this can run in CI without a container runtime.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), "..", "snapshot-wrapper.sh");
const TOKEN = "snapshot-token-for-tests";

/** Stands in for the worker's R2-backed snapshot routes. */
let server: Server;
let port = 0;
let stored: Buffer | null = null;
let putCount = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end('{"error":"unauthorized"}');
      return;
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        stored = Buffer.concat(chunks);
        putCount++;
        res.writeHead(200).end('{"ok":true}');
      });
      return;
    }
    if (req.method === "GET") {
      if (!stored) {
        res.writeHead(404).end('{"error":"no snapshot"}');
        return;
      }
      res.writeHead(200, { "Content-Type": "application/gzip" }).end(stored);
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentpod-snap-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  return root;
}

/** Run the wrapper around a long-lived fake agent, then SIGTERM it. */
function runWrapper(root: string): { proc: ChildProcess; output: () => string } {
  let out = "";
  const proc = spawn("sh", [WRAPPER, "sh", "-c", "while :; do sleep 0.1; done"], {
    env: {
      ...process.env,
      AGENTPOD_SNAPSHOT_ROOT: root,
      AGENTPOD_SNAPSHOT_URL: `http://127.0.0.1:${port}/sandbox/rt_test/snapshot`,
      AGENTPOD_SNAPSHOT_TOKEN: TOKEN,
      // Long, so the periodic loop never fires — this test is about the
      // SIGTERM path, and a background upload would make it ambiguous.
      AGENTPOD_SNAPSHOT_INTERVAL: "3600",
      HOME: "/root",
    },
  });
  proc.stdout?.on("data", (d) => (out += String(d)));
  proc.stderr?.on("data", (d) => (out += String(d)));
  return { proc, output: () => out };
}

const waitFor = async (pred: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

describe("snapshot-wrapper", () => {
  it("saves the workspace on SIGTERM and restores it on the next start", async () => {
    // ── First boot: no snapshot exists, user creates a file ──────────────────
    const first = makeRoot();
    writeFileSync(join(first, "workspace", "README.md"), "work that must survive");

    const a = runWrapper(first);
    expect(await waitFor(() => a.output().includes("no snapshot yet"))).toBe(true);

    // Sleep: the substrate sends SIGTERM.
    a.proc.kill("SIGTERM");
    expect(await waitFor(() => a.proc.exitCode !== null)).toBe(true);
    expect(a.output()).toContain("snapshot uploaded");
    expect(stored).not.toBeNull();

    // ── Wake: a FRESH disk, exactly as Cloudflare describes it ───────────────
    const second = makeRoot();
    expect(existsSync(join(second, "workspace", "README.md"))).toBe(false);

    const b = runWrapper(second);
    expect(await waitFor(() => b.output().includes("restored workspace"))).toBe(true);

    // The whole point of the feature.
    const restored = join(second, "workspace", "README.md");
    expect(existsSync(restored)).toBe(true);
    expect(readFileSync(restored, "utf8")).toBe("work that must survive");

    b.proc.kill("SIGTERM");
    await waitFor(() => b.proc.exitCode !== null);

    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }, 30_000);

  it("starts with an empty workspace rather than looping when restore fails", async () => {
    // A bad restore must never be able to produce a start loop: the first
    // deploy of this worker put seven instances into a silent restart loop and
    // that failure mode must stay unreachable.
    const root = makeRoot();
    let out = "";
    const proc = spawn("sh", [WRAPPER, "sh", "-c", "echo agent-started; sleep 0.3"], {
      env: {
        ...process.env,
        AGENTPOD_SNAPSHOT_ROOT: root,
        AGENTPOD_SNAPSHOT_URL: "http://127.0.0.1:1/sandbox/rt_dead/snapshot", // refused
        AGENTPOD_SNAPSHOT_TOKEN: TOKEN,
        AGENTPOD_SNAPSHOT_INTERVAL: "3600",
        HOME: "/root",
      },
    });
    proc.stdout?.on("data", (d) => (out += String(d)));
    proc.stderr?.on("data", (d) => (out += String(d)));

    expect(await waitFor(() => proc.exitCode !== null)).toBe(true);
    expect(out).toContain("ERROR: restore failed");
    // The agent must still have been started.
    expect(out).toContain("agent-started");

    rmSync(root, { recursive: true, force: true });
  }, 30_000);
});
