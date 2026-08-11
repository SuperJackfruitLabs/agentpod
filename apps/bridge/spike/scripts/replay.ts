/**
 * Task 4: replay a captured session through the projection, offline.
 *
 * Produces RQ1's answer without needing a live station — run it over each
 * findings/acp-raw-*.jsonl capture, one per harness.
 *
 *   bun run scripts/replay.ts findings/acp-raw-<station>.jsonl
 */

import { readFileSync } from "node:fs";
import { project, unmapped, losses } from "../src/project";
import { kindOf } from "../src/hub";

const file = process.argv[2];
if (!file) throw new Error("usage: bun run scripts/replay.ts <capture.jsonl>");

const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);

const byKind = new Map<string, { events: number; activities: number }>();
let events = 0;
let activities = 0;

for (const line of lines) {
  const msg = JSON.parse(line);
  if (msg.t !== "event") continue;
  events++;
  const kind = kindOf(msg.event);
  const produced = project(msg.event);
  activities += produced.length;
  const row = byKind.get(kind) ?? { events: 0, activities: 0 };
  row.events++;
  row.activities += produced.length;
  byKind.set(kind, row);
}

console.log(`\n${file}`);
console.log(`  ${events} ACP events → ${activities} kaambaan activities\n`);
console.log("  kind                                events  activities");
for (const [kind, row] of [...byKind].sort()) {
  const flag = row.activities === 0 ? "  ← DROPPED" : "";
  console.log(`  ${kind.padEnd(36)}${String(row.events).padStart(6)}${String(row.activities).padStart(12)}${flag}`);
}

if (unmapped().length) {
  console.log("\n  UNMAPPED (no projection at all):");
  for (const u of unmapped()) console.log("    " + u);
}
if (losses().length) {
  console.log("\n  LOSSY (projects, but structure lost):");
  for (const l of losses()) console.log("    " + l);
}
console.log();
