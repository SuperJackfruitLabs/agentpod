/**
 * Task 3 observation: drive a live ACP session headlessly and record every
 * distinct event kind. The deduped kind list is RQ1's input — run this against
 * BOTH target stations (Codex on macOS, Hermes on Linux) and keep both captures.
 *
 *   STATION_ID=<codex station>  bun run scripts/probe-acp.ts
 *   STATION_ID=<hermes station> bun run scripts/probe-acp.ts
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { loadHubConfig } from "../src/config";
import { signIn, openSession, connect, kindOf } from "../src/hub";

const PROMPT = process.env.PROMPT ?? "List the files in this directory, then stop.";
const IDLE_EXIT_MS = Number(process.env.IDLE_EXIT_MS ?? 60_000);

mkdirSync("findings", { recursive: true });
const c = loadHubConfig();
const out = `findings/acp-raw-${c.stationId}.jsonl`;

const cookie = await signIn(c);
console.log("signed in");

const session = await openSession(c, cookie, "ask");
console.log("session", session.id, "on station", c.stationId);

const seen = new Set<string>();
let lastAt = Date.now();

const ws = await connect(c, cookie, session.id, (msg) => {
  appendFileSync(out, JSON.stringify(msg) + "\n");
  lastAt = Date.now();

  if (msg.t === "event") {
    const kind = kindOf(msg.event);
    if (!seen.has(kind)) {
      seen.add(kind);
      console.log("NEW KIND", kind);
    }
  }
  if (msg.t === "bye") {
    console.log("bye:", msg.reason);
    finish();
  }
});

ws.send(JSON.stringify({ t: "prompt", text: PROMPT }));
console.log("prompted:", PROMPT);

function finish(): never {
  console.log(`\n${seen.size} distinct kinds → ${out}`);
  for (const k of [...seen].sort()) console.log("  " + k);
  process.exit(0);
}

// The harness has no "I am completely done" frame we can rely on yet — that is
// itself part of what RQ1 is establishing. Exit on silence instead.
setInterval(() => {
  if (Date.now() - lastAt > IDLE_EXIT_MS) finish();
}, 5_000);
