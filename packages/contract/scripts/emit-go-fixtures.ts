/**
 * Emits canonical JSON fixtures for the wire shapes the Go node-agent mirrors
 * by hand, so a Go test can prove its structs still round-trip them losslessly.
 *
 * This is the cheap 10% of zod → JSON Schema → Go codegen. It does not generate
 * Go types; it makes drift *fail a test* instead of failing in production.
 *
 * Every fixture is validated against its schema before being written, so a
 * fixture can never encode a shape the contract would reject.
 *
 *   bun run scripts/emit-go-fixtures.ts          # write
 *   bun run scripts/emit-go-fixtures.ts --check  # fail if checked-in files differ
 *
 * The --check mode is what CI runs: it catches a contract change that never had
 * its fixtures regenerated, which is the same failure codegen would catch.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HostInfo, HelloMsg, HeartbeatMsg, StationHealthReport, HealthReportMsg, ChangesetStatus } from "../src/index";

const OUT_DIR = join(import.meta.dir, "../../../apps/node-agent/internal/contractfix/testdata");

/** name → [schema, value]. The value must satisfy the schema or this throws. */
const FIXTURES: Array<[string, z.ZodTypeAny, unknown]> = [
  ["host_info", HostInfo, { hostname: "fleet-box-1", os: "linux", arch: "arm64", cpuCount: 8 }],

  // capabilities gate whole console features; one silently dropped in the Go
  // mirror is a feature that never appears and errors nowhere.
  ["hello", HelloMsg, {
    type: "hello",
    hostInfo: { hostname: "fleet-box-1", os: "linux", arch: "arm64", cpuCount: 8 },
    version: "v0.1.22",
    capabilities: ["posture"],
  }],

  ["heartbeat", HeartbeatMsg, { type: "heartbeat", ts: 1786445000000 }],

  // Every metric present — catches a Go struct missing a field.
  ["station_health_full", StationHealthReport, {
    key: "codex:4a1482de", ok: true, running: true,
    pid: 73226, cpuPct: 12.5, memBytes: 524288000, uptimeSec: 3600,
  }],

  // Every nullable actually null — catches a Go type that cannot represent null
  // (a plain int64 would silently become 0, which reads as "0% cpu" not "unknown").
  ["station_health_nulls", StationHealthReport, {
    key: "hermes:idle", ok: false, running: false,
    pid: null, cpuPct: null, memBytes: null, uptimeSec: null,
  }],

  ["health_frame", HealthReportMsg, {
    type: "health",
    stations: [
      { key: "codex:4a1482de", ok: true, running: true, pid: 73226, cpuPct: 12.5, memBytes: 524288000, uptimeSec: 3600 },
      { key: "hermes:idle", ok: false, running: false, pid: null, cpuPct: null, memBytes: null, uptimeSec: null },
    ],
  }],

  // Exercises every nullable and both sides — catches a Go struct that cannot
  // represent a detached head, a rename, or an uncounted untracked file.
  ["changeset_status", ChangesetStatus, {
    repo: { branch: "feat/agent-work", head: "9f1c2ab", detached: false },
    base: { ref: "origin/main", sha: "3d4e5f6", reason: "upstream" },
    uncommitted: {
      files: [
        { path: "src/a.ts", oldPath: null, status: "modified", insertions: 12, deletions: 3, binary: false },
        { path: "notes.md", oldPath: null, status: "untracked", insertions: null, deletions: null, binary: false },
        { path: "logo.png", oldPath: null, status: "modified", insertions: null, deletions: null, binary: true },
      ],
      insertions: 12,
      deletions: 3,
    },
    committed: {
      files: [
        { path: "src/new.ts", oldPath: "src/old.ts", status: "renamed", insertions: 1, deletions: 1, binary: false },
      ],
      insertions: 1,
      deletions: 1,
      commits: [
        { sha: "9f1c2ab0000000000000000000000000000000aa", shortSha: "9f1c2ab", subject: "wire the thing up", author: "codex", committedAt: "2026-08-11T09:15:00Z" },
      ],
    },
    truncatedFiles: false,
  }],
];

const check = process.argv.includes("--check");
mkdirSync(OUT_DIR, { recursive: true });

let drifted = 0;
for (const [name, schema, value] of FIXTURES) {
  const parsed = schema.parse(value); // fixture must satisfy the contract
  const json = JSON.stringify(parsed, null, 2) + "\n";
  const path = join(OUT_DIR, `${name}.json`);

  if (check) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current !== json) {
      console.error(`✗ ${name}.json is stale`);
      drifted++;
    }
  } else {
    writeFileSync(path, json);
    console.log(`  wrote ${name}.json`);
  }
}

if (check && drifted) {
  console.error(
    `\n${drifted} fixture(s) out of date. Run:\n` +
      `  cd packages/contract && bun run scripts/emit-go-fixtures.ts\n` +
      `then re-run the node-agent tests — a Go struct may need the new field.`,
  );
  process.exit(1);
}
if (check) console.log("✓ fixtures match the contract");
