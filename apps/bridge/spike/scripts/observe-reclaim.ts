/**
 * Task 8 / RQ4: watch a card while its agent is stranded.
 *
 * Procedure:
 *   1. Seed a card whose work takes several minutes, on a DISPOSABLE workspace.
 *   2. `bun run bridge`; wait for "run … → session …".
 *   3. `CARD_ID=<id> bun run observe` in another terminal.
 *   4. Kill the BRIDGE process only (Ctrl-C). Do not stop the node-agent and do
 *      not end the ACP session — the harness keeps working, the heartbeats stop.
 *   5. Wait out HEARTBEAT_TIMEOUT_MS (15 min, board-do.ts:16).
 *   6. When the card is claimable again, run scripts/stub-run.ts as a SECOND
 *      agent. If it claims while the first harness is still writing to that
 *      workspace, RQ4 has failed and double execution is confirmed.
 *
 * `attemptCount` is the signal: reclaim ends the run and re-queues the card, so
 * a successful reclaim should show as an attempt increment plus a state change.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { Kaambaan } from "../src/kaambaan";

const base = process.env.KAAMBAAN_URL ?? "http://localhost:8787";
const tenant = process.env.TENANT_ID ?? "tnt_dev";
const boardId = process.env.BOARD_ID!;
const token = process.env.AGENT_TOKEN!;
const cardId = process.env.CARD_ID!;
if (!boardId || !token || !cardId) throw new Error("BOARD_ID, AGENT_TOKEN and CARD_ID required");

const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 30_000);

mkdirSync("findings", { recursive: true });
const k = new Kaambaan(base, boardId, token, tenant);
const started = Date.now();
let last = "";

console.log("watching", cardId, `— reclaim expected around 15m`);

for (;;) {
  const card = await k.card(cardId).catch(() => undefined);
  const line = {
    tSec: Math.round((Date.now() - started) / 1000),
    state: card?.state,
    stage: card?.currentStageKey,
    attempts: card?.attemptCount,
    delegate: card?.delegateAgentId,
    at: new Date().toISOString(),
  };
  appendFileSync("findings/rq4.jsonl", JSON.stringify(line) + "\n");

  const sig = `${line.state}/${line.stage}/${line.attempts}/${line.delegate}`;
  if (sig !== last) {
    console.log(`t+${line.tSec}s  CHANGE  state=${line.state} attempts=${line.attempts} delegate=${line.delegate}`);
    last = sig;
  } else {
    console.log(`t+${line.tSec}s  …`);
  }

  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
