# kaambaan Bridge Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer RQ1–RQ5 from [the spike design](../specs/2026-08-11-kaambaan-bridge-spike-design.md) with evidence from a real harness on a real machine, and produce a verdict on whether the §7 seam holds.

**Architecture:** A throwaway Bun process in `apps/bridge/spike/` that claims a card from a locally-running kaambaan over REST, opens an ACP session on a live station through `hub.agentpod.dev`, projects the ACP event stream into kaambaan's activity envelope, handles one permission gate, and completes the card. Every module is small and independently runnable so each task ends in an observation rather than a passing test.

**Tech Stack:** Bun · TypeScript · zod 3.25 · kaambaan REST `/v1` · AgentPod hub REST + WebSocket · `wrangler dev`

## Global Constraints

- **This code never merges to `main` as production.** It lives under `apps/bridge/spike/` with a README declaring it throwaway. Horizon 2 rewrites it test-first or deletes it.
- **Exempt from the repo TDD rule** — it is exploratory. Every other repo rule still applies (commit style, no direct pushes without green CI).
- **zod stays on `3.25.76`.** The zod 4 migration is a separate Horizon 0 item; do not start it here.
- **Do not modify the hub or node-agent.** If the spike cannot work without changing them, that is a finding — record it, do not fix it.
- **Hand-roll the kaambaan REST calls.** Do not use `@kaambaan/agent-sdk`: its `AgentActivity` interface exposes only `{type, body, action, ephemeral, signal}` and omits `usage`, `parameter`, `result` and `signalMetadata` — the exact fields RQ1, RQ2 and RQ5 need.
- **Workspaces used by the spike must be disposable.** Task 8 deliberately strands a running agent mid-edit.
- **Targets:** Codex on the macOS node (`node_161e685104dc488ebd11`) and Hermes on a Linux fleet node.

### Verified wire contract (do not re-derive)

kaambaan, agent-facing, `Authorization: Bearer kbn_…`:

| Call | Path | Body |
|---|---|---|
| claim | `POST /v1/boards/{boardId}/claims` | `{}` |
| heartbeat | `POST /v1/boards/{boardId}/runs/{runId}/heartbeat` | `{leaseEpoch}` |
| activity | `POST /v1/boards/{boardId}/runs/{runId}/activities` | `{leaseEpoch, type, body?, action?, parameter?, result?, ephemeral?, signal?, signalMetadata?, usage?}` |
| complete | `POST /v1/boards/{boardId}/runs/{runId}/complete` | `{leaseEpoch, handoff?}` |
| fail | `POST /v1/boards/{boardId}/runs/{runId}/fail` | `{leaseEpoch, reason}` |

Claim returns `{claimed: boolean, runId?, leaseEpoch?, card?: {id,title,currentStageKey}, stage?: {key,name}, handoff?}`.

Setup (dev headers `X-Tenant-Id`): `POST /v1/boards {name, stages}`, `POST /v1/boards/{id}/cards {title, ownerUserId}`, `POST /v1/agents {name, capabilities}` → `{agent, token}`.

AgentPod hub:

- `POST /api/auth/sign-in/email {email, password}` → session cookie
- `POST /api/stations/{stationId}/acp/sessions {mode}` → `AcpSessionRow`
- `WS /api/acp/sessions/{sessionId}/ws` — client sends `{t:"subscribe",sinceSeq}` · `{t:"prompt",text}` · `{t:"permission-answer",requestSeq,optionId}` · `{t:"cancel"}`; server sends `{t:"event",event}` · `{t:"replay-done",lastSeq}` · `{t:"session",session}` · `{t:"bye",reason}`
- `AcpEvent.type` ∈ `user-prompt · agent-update · permission-request · permission-answer · state · error`, with `payload: unknown` carrying the ACP SDK's `sessionUpdate` verbatim

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/bridge/spike/README.md` | Declares the code throwaway; how to run each task's observation |
| `apps/bridge/spike/package.json` | Bun deps; `zod` from the workspace |
| `apps/bridge/spike/src/config.ts` | Env parsing — one place for URLs, ids, credentials |
| `apps/bridge/spike/src/kaambaan.ts` | Hand-rolled kaambaan REST client (claim/heartbeat/activity/complete/fail) |
| `apps/bridge/spike/src/hub.ts` | Hub sign-in, ACP session create, WS connect |
| `apps/bridge/spike/src/project.ts` | **RQ1 artifact** — ACP event → activity envelope, plus an unmapped-kind recorder |
| `apps/bridge/spike/src/bridge.ts` | The loop: claim → session → stream → activities → gate → complete |
| `apps/bridge/spike/scripts/seed.ts` | Creates board, stages, agent, card in local kaambaan; prints ids + token |
| `apps/bridge/spike/scripts/observe-reclaim.ts` | **RQ4 harness** — polls card/run state while a station is stranded |
| `apps/bridge/spike/findings/` | Raw captures: event dumps, timings, JSON transcripts |
| `docs/superpowers/specs/2026-08-11-kaambaan-bridge-spike-findings.md` | The deliverable verdict |

---

### Task 1: Scaffold and seed a claimable card

**Files:**
- Create: `apps/bridge/spike/README.md`, `apps/bridge/spike/package.json`, `apps/bridge/spike/src/config.ts`, `apps/bridge/spike/scripts/seed.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `loadConfig(): SpikeConfig` with fields `kaambaanUrl, tenantId, boardId, agentToken, hubUrl, hubEmail, hubPassword, stationId`; `seed.ts` prints `BOARD_ID` and `AGENT_TOKEN` for the env file

- [ ] **Step 1: Create the package and README**

`apps/bridge/spike/package.json`:

```json
{
  "name": "@agentpod/bridge-spike",
  "private": true,
  "type": "module",
  "scripts": {
    "seed": "bun run scripts/seed.ts",
    "bridge": "bun run src/bridge.ts",
    "observe": "bun run scripts/observe-reclaim.ts"
  },
  "dependencies": { "zod": "^3.25.76" }
}
```

`apps/bridge/spike/README.md`:

```markdown
# Bridge Spike — THROWAWAY CODE

Answers RQ1–RQ5 in `docs/superpowers/specs/2026-08-11-kaambaan-bridge-spike-design.md`.

**This is not production code.** No tests, no error handling, no retries. It exists to
produce a verdict on the §7 seam. Horizon 2 rewrites it test-first under `apps/bridge/`
or deletes it.

## Run

1. In `~/Projects/kaambaan`: `pnpm --filter @kaambaan/api dev` (wrangler dev on :8787)
2. Here: `bun run seed` → prints BOARD_ID and AGENT_TOKEN
3. Put them in `.env` alongside HUB_* and STATION_ID
4. `bun run bridge`
```

- [ ] **Step 2: Write the config module**

`apps/bridge/spike/src/config.ts`:

```ts
export interface SpikeConfig {
  kaambaanUrl: string; tenantId: string; boardId: string; agentToken: string;
  hubUrl: string; hubEmail: string; hubPassword: string; stationId: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function loadConfig(): SpikeConfig {
  return {
    kaambaanUrl: process.env.KAAMBAAN_URL ?? "http://localhost:8787",
    tenantId: process.env.TENANT_ID ?? "tnt_spike",
    boardId: req("BOARD_ID"),
    agentToken: req("AGENT_TOKEN"),
    hubUrl: process.env.HUB_URL ?? "https://hub.agentpod.dev",
    hubEmail: req("HUB_EMAIL"),
    hubPassword: req("HUB_PASSWORD"),
    stationId: req("STATION_ID"),
  };
}
```

- [ ] **Step 3: Write the seed script**

`apps/bridge/spike/scripts/seed.ts`:

```ts
const BASE = process.env.KAAMBAAN_URL ?? "http://localhost:8787";
const TENANT = process.env.TENANT_ID ?? "tnt_spike";
const dev = { "X-Tenant-Id": TENANT, "Content-Type": "application/json" };

const board = await (await fetch(`${BASE}/v1/boards`, {
  method: "POST", headers: dev,
  body: JSON.stringify({
    name: "Bridge spike",
    stages: [
      { key: "work", name: "Work", order: 0, ownerKind: "capability", owner: "acp" },
      { key: "done", name: "Done", order: 1, ownerKind: "human" },
    ],
  }),
})).json() as { boardId: string };

const agent = await (await fetch(`${BASE}/v1/agents`, {
  method: "POST", headers: dev,
  body: JSON.stringify({ name: "AgentPod fleet", capabilities: ["acp"] }),
})).json() as { agent: { id: string }; token: string };

await fetch(`${BASE}/v1/boards/${board.boardId}/cards`, {
  method: "POST", headers: dev,
  body: JSON.stringify({
    title: "Create hello.txt containing the word spike",
    ownerUserId: "usr_spike",
  }),
});

console.log(`BOARD_ID=${board.boardId}`);
console.log(`AGENT_TOKEN=${agent.token}`);
```

- [ ] **Step 4: Run it and observe**

Run, with `wrangler dev` up in kaambaan:

```bash
cd apps/bridge/spike && bun run seed
```

Expected: two lines, the token starting `kbn_`. If `POST /v1/boards` 404s, kaambaan isn't serving `/v1` — stop and record that as a blocking finding.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/spike
git commit -m "spike(bridge): scaffold and kaambaan seed script"
```

---

### Task 2: Claim and complete a card with a stub worker

Proves the kaambaan half in isolation. If this fails, nothing downstream matters.

**Files:**
- Create: `apps/bridge/spike/src/kaambaan.ts`
- Create: `apps/bridge/spike/scripts/stub-run.ts`

**Interfaces:**
- Consumes: `loadConfig()` from Task 1
- Produces: `class Kaambaan` with `claim(): Promise<Work|null>`, `heartbeat(w)`, `activity(w, a: Activity)`, `complete(w, handoff?)`, `fail(w, reason)`; types `Work {runId, leaseEpoch, card:{id,title,currentStageKey}, stage:{key,name}, handoff}` and `Activity {type, body?, action?, parameter?, result?, ephemeral?, signal?, signalMetadata?, usage?}`

- [ ] **Step 1: Write the client**

`apps/bridge/spike/src/kaambaan.ts`:

```ts
export interface Work {
  runId: string; leaseEpoch: number;
  card: { id: string; title: string; currentStageKey: string };
  stage: { key: string; name: string };
  handoff: unknown;
}

export interface Activity {
  type: "thought" | "action" | "response" | "elicitation" | "error";
  body?: string; action?: string; parameter?: unknown; result?: unknown;
  ephemeral?: boolean; signal?: string; signalMetadata?: unknown;
  usage?: { model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export class Kaambaan {
  constructor(private base: string, private boardId: string, private token: string) {}

  private async post(path: string, body: unknown): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error(`kaambaan ${path} → ${res.status} ${await res.text()}`);
    return res;
  }

  async claim(): Promise<Work | null> {
    const res = await this.post(`/v1/boards/${this.boardId}/claims`, {});
    const b = (await res.json()) as any;
    if (!b?.claimed) return null;
    return { runId: b.runId, leaseEpoch: b.leaseEpoch, card: b.card, stage: b.stage, handoff: b.handoff ?? null };
  }

  private run(w: Work, action: string, extra: Record<string, unknown> = {}) {
    return this.post(`/v1/boards/${this.boardId}/runs/${w.runId}/${action}`, { leaseEpoch: w.leaseEpoch, ...extra });
  }

  heartbeat = (w: Work) => this.run(w, "heartbeat");
  activity = (w: Work, a: Activity) => this.run(w, "activities", { ...a });
  complete = (w: Work, handoff?: unknown) => this.run(w, "complete", { handoff });
  fail = (w: Work, reason: string) => this.run(w, "fail", { reason });
}
```

- [ ] **Step 2: Write the stub run script**

`apps/bridge/spike/scripts/stub-run.ts`:

```ts
import { loadConfig } from "../src/config";
import { Kaambaan } from "../src/kaambaan";

const c = loadConfig();
const k = new Kaambaan(c.kaambaanUrl, c.boardId, c.agentToken);

const work = await k.claim();
if (!work) { console.log("nothing to claim"); process.exit(1); }
console.log("claimed", work.runId, work.card.title, "leaseEpoch", work.leaseEpoch);

await k.heartbeat(work);
await k.activity(work, { type: "thought", body: "stub working", ephemeral: true });
await k.activity(work, { type: "response", body: "stub done" });
await k.complete(work, { stub: true });
console.log("completed", work.runId);
```

- [ ] **Step 3: Run it and observe**

```bash
cd apps/bridge/spike && bun run scripts/stub-run.ts
```

Expected: `claimed …` then `completed …`, with no `kaambaan … → 4xx` lines. Re-running prints `nothing to claim` — the card advanced.

**Record for the findings:** whether `complete` alone advanced the card, or whether the `response` activity was what moved it. kaambaan derives state from activities, so this distinction matters for Task 5.

- [ ] **Step 4: Commit**

```bash
git add apps/bridge/spike
git commit -m "spike(bridge): kaambaan REST client, claim-to-complete verified"
```

---

### Task 3: Drive a live ACP session from a headless process

Proves the AgentPod half in isolation, and surfaces the service-identity gap.

**Files:**
- Create: `apps/bridge/spike/src/hub.ts`
- Create: `apps/bridge/spike/scripts/probe-acp.ts`

**Interfaces:**
- Consumes: `loadConfig()`
- Produces: `signIn(cfg): Promise<string>` returning a `Cookie` header value; `openSession(cfg, cookie, mode): Promise<{id: string}>`; `connect(cfg, cookie, sessionId, onEvent): Promise<WebSocket>`

- [ ] **Step 1: Write the hub client**

`apps/bridge/spike/src/hub.ts`:

```ts
import type { SpikeConfig } from "./config";

export async function signIn(c: SpikeConfig): Promise<string> {
  const res = await fetch(`${c.hubUrl}/api/auth/sign-in/email`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: c.hubEmail, password: c.hubPassword }),
  });
  if (!res.ok) throw new Error(`sign-in failed ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
  if (!cookie) throw new Error("sign-in returned no cookie");
  return cookie;
}

export async function openSession(c: SpikeConfig, cookie: string, mode = "ask"): Promise<{ id: string }> {
  const res = await fetch(`${c.hubUrl}/api/stations/${c.stationId}/acp/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`openSession ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string };
}

export function connect(
  c: SpikeConfig, cookie: string, sessionId: string,
  onEvent: (msg: any) => void,
): Promise<WebSocket> {
  const url = `${c.hubUrl.replace(/^http/, "ws")}/api/acp/sessions/${sessionId}/ws`;
  const ws = new WebSocket(url, { headers: { Cookie: cookie } } as any);
  ws.addEventListener("message", (e) => onEvent(JSON.parse(String(e.data))));
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ t: "subscribe", sinceSeq: 0 }));
      resolve(ws);
    });
    ws.addEventListener("error", reject);
  });
}
```

- [ ] **Step 2: Write the probe**

`apps/bridge/spike/scripts/probe-acp.ts`:

```ts
import { loadConfig } from "../src/config";
import { signIn, openSession, connect } from "../src/hub";
import { appendFileSync } from "node:fs";

const c = loadConfig();
const cookie = await signIn(c);
const session = await openSession(c, cookie, "ask");
console.log("session", session.id);

const seen = new Set<string>();
await connect(c, cookie, session.id, (msg) => {
  appendFileSync("findings/acp-raw.jsonl", JSON.stringify(msg) + "\n");
  if (msg.t === "event") {
    const kind = msg.event.type === "agent-update"
      ? `agent-update:${(msg.event.payload as any)?.sessionUpdate ?? "?"}`
      : msg.event.type;
    if (!seen.has(kind)) { seen.add(kind); console.log("NEW KIND", kind); }
  }
  if (msg.t === "bye") { console.log("bye", msg.reason); process.exit(0); }
});

setTimeout(() => {
  // send a prompt once subscribed; the harness starts working
}, 500);
```

Then send the prompt by holding the socket:

```ts
const ws = await connect(/* … as above … */);
ws.send(JSON.stringify({ t: "prompt", text: "List the files in this directory, then stop." }));
```

- [ ] **Step 3: Run it against the macOS Codex station and observe**

```bash
cd apps/bridge/spike && mkdir -p findings && bun run scripts/probe-acp.ts
```

Expected: a `session …` line, then `NEW KIND` lines. **The distinct-kind list is the RQ1 input** — it is why the probe dedupes rather than just dumping.

Record: if sign-in fails or the WS rejects the `Cookie` header, that is the **service-identity finding** — the bridge has no non-human identity on the hub. Note it and, for the spike only, fall back to a cookie copied from a browser session.

- [ ] **Step 4: Repeat against the Linux Hermes station**

Change `STATION_ID`, rerun, and keep both `findings/acp-raw.jsonl` captures — RQ1 needs two harnesses.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/spike
git commit -m "spike(bridge): drive a live ACP session headlessly, capture event kinds"
```

---

### Task 4: The projection (RQ1)

**Files:**
- Create: `apps/bridge/spike/src/project.ts`
- Reference: `apps/console/src/lib/components/stations/chat/transcript.ts` — the console already destructures these payloads for rendering; it is the reference implementation, not something to import.

**Interfaces:**
- Consumes: `Activity` from Task 2; raw `AcpEvent` objects from Task 3
- Produces: `project(event: AcpEvent): Activity[]` and `unmapped(): string[]`

- [ ] **Step 1: Write the projection**

`apps/bridge/spike/src/project.ts`:

```ts
import type { Activity } from "./kaambaan";

const UNMAPPED = new Set<string>();
export const unmapped = () => [...UNMAPPED];

export function project(event: { type: string; payload: unknown }): Activity[] {
  const p = event.payload as any;

  switch (event.type) {
    case "user-prompt":
      return [{ type: "thought", body: `prompt: ${p?.text ?? ""}`, ephemeral: true }];

    case "permission-request":
      return [{
        type: "elicitation",
        body: p?.title ?? p?.toolCall?.title ?? "The agent needs permission to continue.",
        signal: "select",
        signalMetadata: { requestSeq: (event as any).seq, options: p?.options ?? [] },
      }];

    case "permission-answer":
      return [{ type: "thought", body: `permission answered: ${p?.optionId ?? "?"}`, ephemeral: true }];

    case "error":
      return [{ type: "error", body: String(p?.message ?? "agent error") }];

    case "state":
      return [];  // session lifecycle; kaambaan derives its own state

    case "agent-update":
      return projectUpdate(p);

    default:
      UNMAPPED.add(event.type);
      return [];
  }
}

function projectUpdate(p: any): Activity[] {
  switch (p?.sessionUpdate) {
    case "agent_message_chunk":
      return [{ type: "thought", body: text(p.content), ephemeral: true }];
    case "agent_thought_chunk":
      return [{ type: "thought", body: text(p.content), ephemeral: true }];
    case "tool_call":
      return [{ type: "action", action: p.title ?? p.kind ?? "tool", parameter: p.rawInput }];
    case "tool_call_update":
      return [{ type: "action", action: p.title ?? p.kind ?? "tool", result: p.rawOutput ?? p.content }];
    default:
      UNMAPPED.add(`agent-update:${p?.sessionUpdate ?? "?"}`);
      return [];
  }
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  const c = content as any;
  if (c?.type === "text") return String(c.text ?? "");
  return JSON.stringify(content);
}
```

- [ ] **Step 2: Replay both captures through it**

```bash
cd apps/bridge/spike
bun -e '
  import { project, unmapped } from "./src/project";
  const lines = require("fs").readFileSync("findings/acp-raw.jsonl","utf8").trim().split("\n");
  let n = 0;
  for (const l of lines) { const m = JSON.parse(l); if (m.t === "event") n += project(m.event).length; }
  console.log("activities produced:", n);
  console.log("UNMAPPED:", unmapped());
'
```

Expected: a non-zero activity count and a printed `UNMAPPED` list.

- [ ] **Step 3: Write the mapping table into the findings directory**

Create `apps/bridge/spike/findings/rq1-mapping.md` with one row per observed kind: ACP kind → activity type → what was lost. **The `UNMAPPED` list and the "what was lost" column are RQ1's answer.** Explicitly note anything that only survives by being stringified into `body`.

- [ ] **Step 4: Commit**

```bash
git add apps/bridge/spike
git commit -m "spike(bridge): ACP-to-activity projection and RQ1 mapping table"
```

---

### Task 5: The bridge loop

**Files:**
- Create: `apps/bridge/spike/src/bridge.ts`

**Interfaces:**
- Consumes: `Kaambaan`, `Work`, `Activity`, `signIn`, `openSession`, `connect`, `project`
- Produces: a running process; no exports

- [ ] **Step 1: Write the loop**

`apps/bridge/spike/src/bridge.ts`:

```ts
import { loadConfig } from "./config";
import { Kaambaan, type Work } from "./kaambaan";
import { signIn, openSession, connect } from "./hub";
import { project } from "./project";
import { appendFileSync } from "node:fs";

const c = loadConfig();
const k = new Kaambaan(c.kaambaanUrl, c.boardId, c.agentToken);
const cookie = await signIn(c);

async function workOne(work: Work) {
  const session = await openSession(c, cookie, "ask");
  console.log("run", work.runId, "→ session", session.id);

  const beat = setInterval(() => k.heartbeat(work).catch(() => {}), 60_000);
  let lastEventAt = Date.now();
  let done = false;

  const ws = await connect(c, cookie, session.id, async (msg) => {
    if (msg.t !== "event") return;
    const gap = Date.now() - lastEventAt;
    lastEventAt = Date.now();
    appendFileSync("findings/bridge-timing.jsonl", JSON.stringify({ gap, type: msg.event.type }) + "\n");

    for (const a of project(msg.event)) await k.activity(work, a);
    if (msg.event.type === "state" && (msg.event.payload as any)?.status === "idle") done = true;
  });

  ws.send(JSON.stringify({ t: "prompt", text: work.card.title }));
  while (!done) await new Promise((r) => setTimeout(r, 1000));

  clearInterval(beat);
  await k.activity(work, { type: "response", body: `Completed on station ${c.stationId}.` });
  await k.complete(work, { station: c.stationId, session: session.id });
  ws.close();
  console.log("completed", work.runId);
}

for (;;) {
  const work = await k.claim();
  if (work) await workOne(work);
  else await new Promise((r) => setTimeout(r, 5000));
}
```

- [ ] **Step 2: Seed a fresh card and run the bridge**

```bash
cd apps/bridge/spike && bun run seed   # note the new BOARD_ID/AGENT_TOKEN
bun run bridge
```

Expected: `run … → session …` then `completed …`, and the card visible as done on the board.

- [ ] **Step 3: Record the transcript comparison**

Save the kaambaan activity list beside the console's transcript for the same run into `findings/rq1-side-by-side.md`. **This is the honest RQ1 evidence** — what the board shows versus what the console shows.

- [ ] **Step 4: Commit**

```bash
git add apps/bridge/spike
git commit -m "spike(bridge): end-to-end claim to complete driven by a real harness"
```

---

### Task 6: The permission gate (RQ2)

**Files:**
- Modify: `apps/bridge/spike/src/bridge.ts`

- [ ] **Step 1: Add permission handling to the event callback**

Insert into `workOne`'s callback, after the `project` loop:

```ts
    if (msg.event.type === "permission-request") {
      appendFileSync("findings/rq2.jsonl", JSON.stringify({ at: Date.now(), event: msg.event }) + "\n");
      const opts = (msg.event.payload as any)?.options ?? [];
      console.log("PERMISSION", msg.event.seq, JSON.stringify(opts));
      // Wait for a human on the board, then mirror their choice back into ACP.
      const optionId = await waitForBoardAnswer(work, msg.event.seq, opts);
      ws.send(JSON.stringify({ t: "permission-answer", requestSeq: msg.event.seq, optionId }));
    }
```

- [ ] **Step 2: Implement the board-answer poll**

Append to `bridge.ts`:

```ts
async function waitForBoardAnswer(work: Work, requestSeq: number, opts: any[]): Promise<string> {
  const started = Date.now();
  for (;;) {
    const res = await fetch(`${c.kaambaanUrl}/v1/boards/${c.boardId}/cards/${work.card.id}`, {
      headers: { Authorization: `Bearer ${c.agentToken}` },
    });
    const card = (await res.json()) as any;
    const answer = card?.task?.resolution ?? card?.resolution ?? null;
    if (answer) {
      appendFileSync("findings/rq2.jsonl",
        JSON.stringify({ waitedMs: Date.now() - started, requestSeq, answer }) + "\n");
      return String(answer.optionId ?? opts[0]?.optionId ?? "allow");
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
```

If the card read shape differs, fix the field path against the live response and record the actual shape in the findings — the exact path is not verified.

- [ ] **Step 3: Run a card that triggers a permission**

Seed a card titled `Write the word spike into hello.txt in this workspace`, with session mode `ask` so the write prompts. Expected: `PERMISSION <seq> [...]`, the card at `input-required` on the board, and after answering, the run completing.

- [ ] **Step 4: Record RQ2's answer**

In `findings/rq2.jsonl` you now have the wait duration and the answer. Confirm from the timing whether the lease survived — heartbeats continue during the wait because the interval is still running. **Note explicitly whether an `elicitation` activity with `signalMetadata` carried ACP's option list intact.**

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/spike
git commit -m "spike(bridge): permission gate round-trip through input-required"
```

---

### Task 7: Silence and usage instrumentation (RQ3, RQ5)

**Files:**
- Modify: `apps/bridge/spike/src/project.ts`

- [ ] **Step 1: Capture usage if the harness emits it**

Add to `projectUpdate`, before the `default` case:

```ts
    case "usage":
    case "token_usage":
      return [{
        type: "thought", ephemeral: true, body: "usage",
        usage: {
          model: p.model,
          inputTokens: p.inputTokens ?? p.usage?.input_tokens,
          outputTokens: p.outputTokens ?? p.usage?.output_tokens,
          costUsd: p.costUsd ?? p.total_cost_usd,
        },
      }];
```

- [ ] **Step 2: Compute the silence figure**

```bash
cd apps/bridge/spike
bun -e '
  const g = require("fs").readFileSync("findings/bridge-timing.jsonl","utf8").trim().split("\n").map(l=>JSON.parse(l).gap);
  console.log("max silence ms:", Math.max(...g), "vs HEARTBEAT_TIMEOUT_MS 900000");
'
```

- [ ] **Step 3: Record RQ3 and RQ5**

RQ3 passes if max silence is far below 900000. RQ5 passes if any usage figures were captured for either harness — record **per harness**, since Codex advertises usage and Hermes may not.

- [ ] **Step 4: Commit**

```bash
git add apps/bridge/spike
git commit -m "spike(bridge): usage capture and inter-event silence measurement"
```

---

### Task 8: The reclaim experiment (RQ4)

**Files:**
- Create: `apps/bridge/spike/scripts/observe-reclaim.ts`

- [ ] **Step 1: Write the observer**

```ts
import { loadConfig } from "../src/config";
import { appendFileSync } from "node:fs";

const c = loadConfig();
const cardId = process.env.CARD_ID!;
const started = Date.now();

for (;;) {
  const res = await fetch(`${c.kaambaanUrl}/v1/boards/${c.boardId}/cards/${cardId}`, {
    headers: { Authorization: `Bearer ${c.agentToken}` },
  });
  const card = (await res.json()) as any;
  const line = { tMs: Date.now() - started, state: card?.task?.state ?? card?.state, runs: card?.runs?.length };
  appendFileSync("findings/rq4.jsonl", JSON.stringify(line) + "\n");
  console.log(line);
  await new Promise((r) => setTimeout(r, 30_000));
}
```

- [ ] **Step 2: Start a long-running card and strand it**

1. Seed a card whose work takes several minutes on a **disposable** workspace.
2. Start `bun run bridge`; wait for `run … → session …`.
3. Start `CARD_ID=<id> bun run observe`.
4. **Kill the bridge process only** (`Ctrl-C`) — do not stop the node-agent and do not end the ACP session. The harness keeps working; the heartbeats stop.

- [ ] **Step 3: Wait out the timeout and record what happens**

Fifteen minutes. Watch for the card returning to a claimable state. Then check, on the station, whether the harness is still running and still writing:

```bash
apn logs -n 50 | grep -v opencode.db
ls -la <disposable workspace>
```

- [ ] **Step 4: Prove or disprove double execution**

With the card re-offered, run `bun run scripts/stub-run.ts` — a *second* agent claiming the same card. If it claims while the first harness is still writing to that workspace, **RQ4 has failed and the finding is confirmed**: reclaim produces concurrent execution with no fencing on our side.

Record in `findings/rq4.jsonl` plus a prose note: time to reclaim, whether the station kept working, whether a second claim succeeded, and what the workspace looked like afterwards.

- [ ] **Step 5: Commit**

```bash
git add apps/bridge/spike
git commit -m "spike(bridge): reclaim experiment, RQ4 evidence"
```

---

### Task 9: The findings document and the PR

**Files:**
- Create: `docs/superpowers/specs/2026-08-11-kaambaan-bridge-spike-findings.md`

- [ ] **Step 1: Write the verdict**

One section per research question, each with: the question, the evidence (pointing at the `findings/` capture), and a verdict of **pass / pass-with-changes / fail**. Then a closing recommendation of exactly one of:

- **harden** — §7 stands, Horizon 2 proceeds
- **harden with changes to §7** — the seam works but the strategy needs amending; list the amendments
- **abandon** — the seam does not hold; explain what replaces it

Include a short "what this cost" note: what the spike could not test, and what it changed about the plan.

- [ ] **Step 2: Record the two known gaps regardless of verdict**

Both are already visible and belong in the findings even if every RQ passes:

1. **The bridge has no service identity on the hub.** Auth is cookie-based via `POST /api/auth/sign-in/email`; there is no bearer or API-key path. Horizon 2 needs one, and it connects to the H3 note about a station carrying two credentials.
2. **`@kaambaan/agent-sdk`'s `AgentActivity` is a subset of the documented envelope** — no `usage`, `parameter`, `result` or `signalMetadata`. Either kaambaan widens the SDK or every bridge hand-rolls, which is a kaambaan-side change worth raising.

- [ ] **Step 3: Open the PR**

```bash
git checkout -b spike/kaambaan-bridge   # if not already on it
git push -u origin spike/kaambaan-bridge
gh pr create --title "spike: kaambaan bridge — RQ1-RQ5 findings" --body "…"
```

The PR body must state plainly that `apps/bridge/spike/` is throwaway, that it is exempt from TDD by the spec, and that Horizon 2 rewrites it test-first or deletes it. Link the design spec and the findings document.

---

## Self-Review

**Spec coverage:** RQ1 → Tasks 3, 4, 5. RQ2 → Task 6. RQ3 → Task 7. RQ4 → Task 8. RQ5 → Task 7. Two harnesses → Task 3 Step 4 and Task 7 Step 3. Live hub → Task 3. Poll at 5s → Task 5. Disposable workspaces → Task 8. Findings deliverable → Task 9. Spike-does-not-merge-as-production → README in Task 1 and PR body in Task 9.

**Known unverified paths, flagged in-place rather than hidden:** the card-read endpoint used in Tasks 6 and 8 (`GET /v1/boards/{id}/cards/{cardId}`) and its resolution field path are inferred, not confirmed against the running service — Task 6 Step 2 instructs fixing them against the live response and recording the real shape.

> **Corrections applied during execution (2026-08-11).** Tasks 1 and 2 ran against a live local
> kaambaan and disproved four assumptions above. Full detail in
> `apps/bridge/spike/findings/verified-surface.md`; the short version:
>
> - `pnpm dev:setup` (D1 migrations + seed) is a prerequisite for `pnpm dev`, and the seeded
>   tenant is `tnt_dev` / `usr_dev`. The plan's `tnt_spike` fails the catalog foreign key with
>   an opaque `500 D1_ERROR` naming nothing.
> - **There is no card-read endpoint.** Both `/cards` and `/cards/:card` reject GET with 405.
>   `GET /v1/boards/{board}` returns the whole snapshot and is the only read surface — better
>   than planned, since each card carries `attemptCount` (the RQ4 reclaim signal) and `costUsd`.
> - `POST /cards` returns `{card:{id}}`, not `{cardId}`.
> - **A `response` activity does not advance the card**, contradicting doc 04 §4. Only
>   `complete` did. The bridge must call it explicitly.

**Type consistency:** `Work` and `Activity` are defined once in Task 2 and used unchanged in Tasks 4–8. `project()` returns `Activity[]` throughout. `signIn`/`openSession`/`connect` keep the Task 3 signatures in Task 5.
