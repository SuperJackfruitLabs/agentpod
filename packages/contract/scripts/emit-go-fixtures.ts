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
import { HostInfo, HelloMsg, HeartbeatMsg, StationHealthReport, HealthReportMsg } from "../src/index";

const OUT_DIR = join(import.meta.dir, "../../../apps/node-agent/internal/contractfix/testdata");

/** name → [schema, value]. The value must satisfy the schema or this throws. */
const FIXTURES: Array<[string, z.ZodTypeAny, unknown]> = [
  ["host_info", HostInfo, { hostname: "fleet-box-1", os: "linux", arch: "arm64", cpuCount: 8 }],

  ["hello", HelloMsg, {
    type: "hello",
    hostInfo: { hostname: "fleet-box-1", os: "linux", arch: "arm64", cpuCount: 8 },
    version: "v0.1.18",
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
