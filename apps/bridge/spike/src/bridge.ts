/**
 * The bridge loop — Tasks 5 and 6.
 *
 *   claim → open ACP session → stream events → project to activities
 *         → hold on a permission gate → complete
 *
 * Throwaway. No retries, no reconnection, no concurrency: one card at a time,
 * one station, one agent identity. Its job is evidence, not uptime.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "./config";
import { Kaambaan, type Work } from "./kaambaan";
import { signIn, openSession, connect, kindOf, type AcpEvent } from "./hub";
import { project, unmapped, losses } from "./project";

const POLL_MS = Number(process.env.POLL_MS ?? 5_000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 60_000);
/** Kaambaan reclaims at 15 min (board-do.ts:16). Give up well before that. */
const IDLE_DONE_MS = Number(process.env.IDLE_DONE_MS ?? 120_000);

mkdirSync("findings", { recursive: true });
const c = loadConfig();
const k = new Kaambaan(c.kaambaanUrl, c.boardId, c.agentToken, c.tenantId);
const cookie = await signIn(c);
console.log("signed in; polling for work every", POLL_MS, "ms");

async function workOne(work: Work): Promise<void> {
  const session = await openSession(c, cookie, "ask");
  console.log(`run ${work.runId} → session ${session.id} ("${work.card.title}")`);

  const beat = setInterval(() => {
    k.heartbeat(work).catch((e) => console.error("heartbeat failed", e));
  }, HEARTBEAT_MS);

  let lastEventAt = Date.now();
  let settled = false;
  const kinds = new Set<string>();

  const ws = await connect(c, cookie, session.id, (msg) => {
    if (msg.t === "bye") {
      console.log("session ended:", msg.reason);
      settled = true;
      return;
    }
    if (msg.t !== "event") return;

    const gap = Date.now() - lastEventAt;
    lastEventAt = Date.now();
    kinds.add(kindOf(msg.event));
    appendFileSync(
      "findings/bridge-timing.jsonl",
      JSON.stringify({ gapMs: gap, kind: kindOf(msg.event), at: new Date().toISOString() }) + "\n",
    );

    // Fire-and-forget: ordering is preserved by kaambaan's seq, and awaiting
    // here would block the socket callback.
    for (const a of project(msg.event)) {
      k.activity(work, a).catch((e) => console.error("activity failed", e));
    }

    if (msg.event.type === "permission-request") void handlePermission(work, ws, msg.event);
  });

  ws.send(JSON.stringify({ t: "prompt", text: work.card.title }));

  while (!settled && Date.now() - lastEventAt < IDLE_DONE_MS) {
    await new Promise((r) => setTimeout(r, 1_000));
  }

  clearInterval(beat);
  await k.activity(work, {
    type: "response",
    body: `Ran on station \`${c.stationId}\` (ACP session \`${session.id}\`).`,
  });
  // Verified in Task 2: a `response` activity does NOT advance the card, even
  // though doc 04 §4 says it drives state to completed. `complete` is required.
  await k.complete(work, { station: c.stationId, session: session.id });
  ws.close();

  console.log(`completed ${work.runId}; kinds seen: ${[...kinds].sort().join(", ")}`);
  if (unmapped().length) console.log("UNMAPPED:", unmapped());
  if (losses().length) console.log("LOSSES:", losses());
}

/**
 * ⚠️ UNVERIFIED PATH. The board snapshot exposes `gates`, and a card sitting on
 * an elicitation should surface there — but the resolution shape was never
 * observed (the spike could not reach a live hub). This logs the raw gate on
 * first sight so the real shape gets recorded, then answers ACP with the human's
 * choice, falling back to the first offered option.
 */
async function handlePermission(work: Work, ws: WebSocket, event: AcpEvent): Promise<void> {
  const options = ((event.payload as any)?.options ?? []) as Array<{ optionId?: string; name?: string }>;
  const started = Date.now();
  console.log(`PERMISSION seq=${event.seq}`, JSON.stringify(options));
  appendFileSync("findings/rq2.jsonl", JSON.stringify({ phase: "requested", event }) + "\n");

  let logged = false;
  for (;;) {
    const board = await k.board().catch(() => null);
    const card = board?.cards.find((x) => x.id === work.card.id);

    if (board && !logged) {
      logged = true;
      appendFileSync(
        "findings/rq2.jsonl",
        JSON.stringify({ phase: "gate-shape", gates: board.gates, cardState: card?.state }) + "\n",
      );
    }

    const gate = (board?.gates as any[] | undefined)?.find(
      (g) => g?.cardId === work.card.id && (g?.resolution ?? g?.resolvedAt ?? g?.answer),
    );

    if (gate) {
      const optionId =
        gate.resolution?.optionId ?? gate.answer?.optionId ?? options[0]?.optionId ?? "allow";
      appendFileSync(
        "findings/rq2.jsonl",
        JSON.stringify({ phase: "answered", waitedMs: Date.now() - started, optionId, gate }) + "\n",
      );
      ws.send(JSON.stringify({ t: "permission-answer", requestSeq: event.seq, optionId }));
      console.log(`permission answered after ${Math.round((Date.now() - started) / 1000)}s → ${optionId}`);
      return;
    }

    await new Promise((r) => setTimeout(r, 3_000));
  }
}

for (;;) {
  const work = await k.claim();
  if (work) await workOne(work);
  else await new Promise((r) => setTimeout(r, POLL_MS));
}
