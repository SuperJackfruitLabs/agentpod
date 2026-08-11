/**
 * Task 2 observation: claim and complete a card with no ACP at all.
 *
 * Proves the kaambaan half in isolation. If this fails, nothing downstream
 * matters. Also records WHICH call advanced the card — kaambaan derives state
 * from activities, so whether `complete` or the `response` activity moved it is
 * a real distinction for the bridge loop.
 */

import { Kaambaan } from "../src/kaambaan";

const base = process.env.KAAMBAAN_URL ?? "http://localhost:8787";
const tenant = process.env.TENANT_ID ?? "tnt_dev";
const boardId = process.env.BOARD_ID!;
const token = process.env.AGENT_TOKEN!;
if (!boardId || !token) throw new Error("BOARD_ID and AGENT_TOKEN required (run `bun run seed`)");

const k = new Kaambaan(base, boardId, token, tenant);

const work = await k.claim();
if (!work) {
  console.log("nothing to claim");
  process.exit(1);
}
console.log("claimed", work.runId, `"${work.card.title}"`, "leaseEpoch", work.leaseEpoch);

const stateAfter = async (label: string) => {
  const c = await k.card(work.card.id);
  console.log(`  after ${label}: state=${c?.state} stage=${c?.currentStageKey} attempts=${c?.attemptCount}`);
};

await stateAfter("claim");
await k.heartbeat(work);
await k.activity(work, { type: "thought", body: "stub working", ephemeral: true });
await stateAfter("thought");
await k.activity(work, { type: "response", body: "stub done" });
await stateAfter("response");
await k.complete(work, { stub: true });
await stateAfter("complete");

console.log("completed", work.runId);
