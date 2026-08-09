# ACP Slice 2 — Hub Session Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hub-owned ACP sessions: the hub terminates the ACP protocol over slice-1's broker rails, persists replayable transcripts in Postgres, enforces per-session permission modes, and exposes a console-facing session WebSocket — everything slice 3's chat UI needs.

**Architecture:** The hub is the protocol-level ACP client. Per live session it holds one broker stream to the node (`acp.open` → `acp.attach` + input frames) wrapped as the byte streams the official TS SDK consumes; SDK callbacks become append-only `acp_events` rows fanned out to subscribed console sockets. Sessions survive console disconnects; hub restart ends sessions honestly with boot reconciliation that best-effort `acp.close`s orphaned node processes (slice-1 carry-in #1).

**Tech Stack:** Bun + Hono + Drizzle/Postgres (existing hub), `@agentclientprotocol/sdk` (official TS SDK — use its modern fluent `client()` API; read the installed d.ts + the repo examples for exact symbols, the plan specifies contracts not SDK symbol names), zod (contract).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-09-acp-sessions-design.md` (Hub + Architecture sections) plus slice-2 carry-ins recorded in `.superpowers/sdd/2026-08-09-acp-slice1-rails/progress.md` and the `acp-sessions-program` memory.
- Commands: hub tests `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test`; contract `cd packages/contract && bun test`. DB-touching tests live in `tests/integration/` or next to routes with per-file row cleanup in `afterAll`.
- WS/gateway tests build a minimal Hono app — never import `src/index.ts`. Reuse `station-terminal.test.ts`'s `connectFakeNode` harness style for scripted nodes.
- **Frame seam (slice-1 fact):** ACP input frames are keyed by the ACP **session id** (`broker.sendFrame(nodeId, { type: "input", id: <acpSessionId>, data })`) — NOT the attach-stream id the terminal uses. The node's `acpHandler` routes by session id.
- **`acp.open` is idempotent-by-key** on the node (carry-in #4): opening for a station with a live process returns the existing session. For a fresh process, `acp.close` the old one first.
- Session states: `starting → idle ⇄ working → waiting → ended(<reason>)`. All user-visible strings use the "Couldn't X." grammar.
- Conventional commits + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Branch `ui-revamp` in this worktree; never touch develop/main checkout.

## File Map

| File | Responsibility |
|---|---|
| `packages/contract/src/station.ts` | forward-compatible capability parsing (carry-in #2) |
| `packages/contract/src/protocol.ts` | InputMsg id-semantics doc comment (carry-in #3) |
| `packages/contract/src/acp-session.ts` (+ test) | session/event/WS-message schemas shared hub↔console |
| `apps/hub/src/db/schema/acp.ts` (+ migration per repo pattern, + unit test) | `acp_sessions`, `acp_events` |
| `apps/hub/src/services/acp-transport.ts` (+ test) | broker stream ↔ SDK byte-stream adapter |
| `apps/hub/src/services/acp-sessions.ts` (+ integration test) | session lifecycle, persistence, permission queue, reconciliation |
| `apps/hub/src/routes/station-acp.ts` (+ test) | REST create/list + session WebSocket |
| `apps/hub/src/index.ts` | mount routes; boot reconciliation hook |

---

### Task 1: Contract — forward-compat capabilities, ACP session schemas, InputMsg doc

**Files:**
- Modify: `packages/contract/src/station.ts` (capability array parsing)
- Modify: `packages/contract/src/protocol.ts` (doc comment only, on InputMsg)
- Create: `packages/contract/src/acp-session.ts`; export from `src/index.ts`
- Test: `packages/contract/src/acp-session.test.ts` (+ extend `station.test.ts`)

**Interfaces (Produces):**

```ts
// station.ts — keep the Capability enum, but station rows FILTER unknown
// capability strings instead of rejecting the whole row (carry-in #2: an old
// hub must not break auto-adopt when a newer node advertises new capabilities).
export const CapabilityList = z
  .array(z.string())
  .transform((xs) => xs.filter((x): x is Capability => Capability.safeParse(x).success));
// StationRow.capabilities (and the detect result's station shape) use CapabilityList.

// acp-session.ts
export const AcpSessionMode = z.enum(["ask", "accept-edits", "full-auto"]);
export const AcpSessionStatus = z.enum(["starting", "idle", "working", "waiting", "ended"]);
export const AcpSessionRow = z.object({
  id: z.string(), stationId: z.string(), userId: z.string(),
  mode: AcpSessionMode, status: AcpSessionStatus,
  endedReason: z.string().nullable(),
  createdAt: z.string(), lastEventAt: z.string(),
});
// Append-only transcript event. `payload` is intentionally loose (z.unknown()):
// it carries the SDK's sessionUpdate/permission payloads verbatim; the console
// renders known shapes and ignores the rest. `seq` is a per-session monotonic
// integer assigned by the hub.
export const AcpEventType = z.enum([
  "user-prompt", "agent-update", "permission-request", "permission-answer", "state", "error",
]);
export const AcpEvent = z.object({
  sessionId: z.string(), seq: z.number().int(), type: AcpEventType,
  payload: z.unknown(), createdAt: z.string(),
});
// Console → hub over the session WS:
export const AcpClientMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("subscribe"), sinceSeq: z.number().int().nonnegative() }),
  z.object({ t: z.literal("prompt"), text: z.string().min(1) }),
  z.object({ t: z.literal("cancel") }),
  z.object({ t: z.literal("permission-answer"), requestSeq: z.number().int(), optionId: z.string() }),
  z.object({ t: z.literal("set-mode"), mode: AcpSessionMode }),
]);
// Hub → console:
export const AcpServerMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("event"), event: AcpEvent }),
  z.object({ t: z.literal("replay-done"), lastSeq: z.number().int() }),
  z.object({ t: z.literal("session"), session: AcpSessionRow }),
  z.object({ t: z.literal("bye"), reason: z.string() }),
]);
```

- [ ] **Step 1 (RED):** tests — CapabilityList filters unknowns (`["health","acp","future-cap"] → ["health","acp"]`) and StationRow with an unknown capability parses instead of failing; AcpClientMsg/AcpServerMsg round-trip each variant; AcpEvent accepts arbitrary payloads.
- [ ] **Step 2:** run `bun test` → new tests fail.
- [ ] **Step 3:** implement; add the InputMsg doc comment in protocol.ts: terminal input frames use the attach-request id, ACP input frames use the ACP session id (routed by the node's acpHandler).
- [ ] **Step 4:** `bun test` green (fix any station.test.ts fallout by intent: filtering is the new correct behavior).
- [ ] **Step 5:** Commit `feat(contract): acp session schemas + forward-compatible capability parsing`.

---

### Task 2: Hub DB — `acp_sessions` + `acp_events`

**Files:**
- Create: `apps/hub/src/db/schema/acp.ts`; export via `src/db/schema/index.ts`
- Migration: follow EXACTLY how `provisionedRuntimes` (schema/nodes.ts) got its migration into the boot-applied set — read `src/db/migrations.ts` / the drizzle setup first and replicate the established mechanism.
- Test: `apps/hub/tests/unit/acp.schema.test.ts` (mirror `runtimes.schema.test.ts`)

Schema (Drizzle, Postgres):

```ts
export const acpSessions = pgTable("acp_sessions", {
  id: text("id").primaryKey(),                    // "acps_" + uuid-ish
  stationId: text("station_id").notNull(),        // FK stations.id ON DELETE CASCADE
  userId: text("user_id").notNull(),
  mode: text("mode").notNull(),                   // ask | accept-edits | full-auto
  status: text("status").notNull(),               // starting|idle|working|waiting|ended
  endedReason: text("ended_reason"),
  nodeSessionId: text("node_session_id"),         // the node-side acp_* id, for reconciliation acp.close
  createdAt: timestamp("created_at").notNull(),
  lastEventAt: timestamp("last_event_at").notNull(),
});
export const acpEvents = pgTable("acp_events", {
  sessionId: text("session_id").notNull(),        // FK acp_sessions.id ON DELETE CASCADE
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at").notNull(),
}, (t) => [primaryKey({ columns: [t.sessionId, t.seq] })]);
```

- [ ] **Step 1 (RED):** schema unit test asserting tables/columns/PKs exist (pattern: runtimes.schema.test.ts).
- [ ] **Step 2:** fail. **Step 3:** implement schema + migration. **Step 4:** green + full hub suite green (migration applies against the :5434 test DB). **Step 5:** Commit `feat(hub): acp session + event tables`.

---

### Task 3: Hub — ACP transport adapter (broker ↔ SDK streams)

**Files:**
- Create: `apps/hub/src/services/acp-transport.ts`
- Test: `apps/hub/src/services/acp-transport.test.ts`
- Dependency: `cd apps/hub && bun add @agentclientprotocol/sdk` (pin exact installed version in package.json; read its d.ts + examples before coding).

**Interfaces (Produces — Task 4 consumes verbatim):**

```ts
export interface AcpWire {
  /** WHATWG streams carrying raw JSON-RPC bytes, in the shape the SDK's
   *  connection constructor/fluent client() expects. */
  readable: ReadableStream<Uint8Array>;   // node → hub (acp.attach chunks, base64-decoded)
  writable: WritableStream<Uint8Array>;   // hub → node (sent as input frames keyed by nodeSessionId)
  /** Resolves when the node stream ends; carries the exit reason parsed from
   *  the in-band {"event":"exit","reason":...} frame, or "eof". */
  closed: Promise<string>;
  /** Detach + best-effort acp.close on the node. Idempotent. */
  close(): Promise<void>;
  nodeSessionId: string;
}
export async function openAcpWire(nodeId: string, stationKey: string): Promise<AcpWire>;
// Throws Error("Couldn't start the agent process — <broker error>.") when
// acp.open fails or the node is offline.
```

Behavior: `broker.request(nodeId, "acp.open", { key })` → `{sessionId}`; `broker.stream(nodeId, "acp.attach", { sessionId }, onChunk)` where each non-null chunk is base64-decoded into `readable`; a chunk decoding to JSON `{"event":"exit","reason":...}` resolves `closed` with the reason and terminates `readable` (do NOT forward the exit frame as protocol bytes — it is not JSON-RPC); eof without exit resolves `closed` with `"eof"`. Writes to `writable` are base64-encoded into `broker.sendFrame(nodeId, { type: "input", id: sessionId, data })` (SESSION id — global constraint). `close()` cancels the attach stream and fires `broker.request(nodeId, "acp.close", { sessionId })` best-effort.

- [ ] **Step 1 (RED):** tests with the `connectFakeNode` harness (copy its setup): fake node answers `acp.open`, then on `acp.attach` streams two base64 chunks of ndjson bytes and echoes input frames back as chunks; assert (a) bytes written to `writable` arrive at the fake node as input frames keyed by the SESSION id, (b) chunks surface via `readable` in order, (c) an exit frame resolves `closed` with the reason and does not leak into `readable`, (d) `close()` sends `acp.close` + cancel.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** green. **Step 5:** Commit `feat(hub): acp wire — broker stream to SDK byte-stream adapter`.

---

### Task 4: Hub — session service

**Files:**
- Create: `apps/hub/src/services/acp-sessions.ts`
- Test: `apps/hub/src/services/acp-sessions.test.ts` (integration: real test DB + fake node speaking scripted ACP)

**Interfaces (Produces — Task 5 consumes verbatim):**

```ts
export interface CreateSessionInput { stationId: string; userId: string; mode: AcpSessionMode; }
export async function createSession(input: CreateSessionInput): Promise<AcpSessionRow>;
export async function listSessions(userId: string, stationId: string): Promise<AcpSessionRow[]>;
export async function getSession(userId: string, sessionId: string): Promise<AcpSessionRow | null>;
export async function promptSession(userId: string, sessionId: string, text: string): Promise<void>;
export async function cancelTurn(userId: string, sessionId: string): Promise<void>;
export async function answerPermission(userId: string, sessionId: string, requestSeq: number, optionId: string): Promise<void>;
export async function setMode(userId: string, sessionId: string, mode: AcpSessionMode): Promise<void>;
export async function endSession(userId: string, sessionId: string, reason: string): Promise<void>;
/** Subscribe to live events; replay is the caller's job (read acp_events). */
export function subscribe(sessionId: string, fn: (e: AcpEvent) => void): () => void;
/** Boot reconciliation: mark all non-ended sessions ended("hub restarted");
 *  when each affected node next connects, best-effort acp.close its orphaned
 *  nodeSessionId. Call from index.ts boot after initDatabase. */
export async function reconcileOnBoot(): Promise<void>;
```

Behavior requirements:
1. `createSession`: verify station belongs to user + has the `acp` capability (`gateCapability`) + node online; for fresh-process semantics, if a live in-memory session exists for the station, refuse with "An active session already exists for this agent." (single session per station in slice 2); `openAcpWire` → SDK `initialize` → `session/new` (cwd = station workspace if the SDK requires one; consult d.ts) → insert row (`status: "idle"`, nodeSessionId) → `state` event. On any step failing: row `ended(<reason>)` + `error` event; wire closed.
2. Events: every persisted event gets the next `seq` (per-session counter held in memory, seeded from MAX(seq)); write to `acp_events`, bump `last_event_at`, then fan out to subscribers. Event mapping: prompt → `user-prompt`; every SDK sessionUpdate notification → `agent-update` with the raw update payload; permission flow → `permission-request` / `permission-answer`; status transitions → `state` `{status}`; wire close → `state` `{status:"ended", reason}` + row update.
3. `promptSession`: refuse unless status idle; set `working` (state event); call SDK prompt; on turn end → `idle`. Audit via `recordAudit` (verb "acp.prompt", params `{chars: text.length}` — never log prompt text to the audit table).
4. Permission callback (SDK requestPermission): consult mode — `full-auto`: pick the SDK-provided allow/first-accept option, persist request+answer events (auto flag in payload); `accept-edits`: auto-allow requests whose toolCall kind is a file edit (consult SDK types for the discriminator), else fall through to ask; `ask`: persist `permission-request`, set status `waiting` (state event), park the SDK promise in an in-memory map keyed `(sessionId, requestSeq)`; `answerPermission` resolves it, persists `permission-answer`, restores `working`. Session end/cancel rejects parked promises with the SDK's cancelled outcome.
5. `cancelTurn`: SDK cancel notification; status back to `idle`.
6. Node offline mid-session (wire `closed` rejects/resolves while status != ended): status `waiting` + state event `{reason:"node offline"}`; a 60s grace timer then ends the session ("Couldn't reach the node.") — no reattach in slice 2 (recorded as slice-3 improvement).
7. `reconcileOnBoot` per its doc; use `connectionManager` online events or a simple online-check-on-interval for the best-effort close (keep it simple: attempt close for orphans whose node is online at boot + log others).

- [ ] **Step 1 (RED):** integration tests with a scripted fake-node ACP agent (extend the Task-3 fake: respond to `initialize`, `session/new`, stream a `session/update` on prompt, issue a `session/request_permission`, honor cancel): create→idle with events persisted; prompt→working→agent-update→idle ordering by seq; ask-mode permission parks + answerPermission resolves + events; full-auto auto-answers; wrong-user access returns null/throws; endSession closes wire (fake node sees acp.close); reconcileOnBoot marks stale rows ended.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** hub suite green. **Step 5:** Commit `feat(hub): acp session service — hub-owned sessions, permission modes, transcripts`.

---

### Task 5: Hub — REST + session WebSocket routes

**Files:**
- Create: `apps/hub/src/routes/station-acp.ts`
- Modify: `apps/hub/src/index.ts` (mount + `reconcileOnBoot()` after initDatabase, before node gateway serves)
- Test: `apps/hub/src/routes/station-acp.test.ts`

Endpoints:
- `POST /api/stations/:id/acp/sessions` `{mode}` → 201 AcpSessionRow (session create; 400 invalid mode, 403 capability, 404 station, 409 active-session-exists, 502 node offline/open failure).
- `GET /api/stations/:id/acp/sessions` → rows (newest first).
- `GET /api/acp/sessions/:sessionId/ws` (upgrade): mirror `station-terminal.ts` exactly for CSWSH origin check + auth + ownership; protocol per contract AcpClientMsg/AcpServerMsg: on `subscribe` → send `session` row, replay `acp_events` where seq > sinceSeq in order, `replay-done`, then live-subscribe; `prompt`/`cancel`/`permission-answer`/`set-mode` → corresponding service calls, errors surfaced as an `error` event (not a WS close); client disconnect → unsubscribe ONLY (session lives on — hub-owned); `bye` when the session ends.

- [ ] **Step 1 (RED):** route tests (minimal Hono app + fake auth middleware + fake node, per station-terminal.test.ts): create/list happy path + each error status; WS: subscribe replays persisted events then streams a live one; prompt over WS produces agent-update; disconnect does NOT end the session (session row still non-ended; a second WS subscribe replays everything).
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** hub suite green. **Step 5:** Commit `feat(hub): acp session REST + console session WebSocket`.

---

### Task 6: Slice gate — suites, PR, CI, live verification (controller-run)

- [ ] `cd packages/contract && bun test` and full hub + node-agent + console suites green.
- [ ] Push; PR `feat: ACP slice 2 — hub session service`; CI green.
- [ ] Live verification on the box (hub deploy after merge):
  1. Deploy hub (`git pull`, bun install, restart, health 200; boot log shows reconciliation ran).
  2. **OpenCode structural**: script (bun, run on the box or via authed WS from dev) → create session on `opencode-one`'s station → expect initialize/session-new success, state events in DB; prompt → opencode replies or errors cleanly (no provider creds is acceptable — the error must land as a transcript event, not a hang); end session → node process closed (`docker exec pgrep` shows no `opencode acp` remnant).
  3. **Hermes real prompt**: build node-agent linux/amd64 from main, deploy to buddhimaan (scp + `apn restart`), confirm hermes stations re-detect with `acp` capability; create session on a hermes profile station; send a real prompt; verify streamed agent-update events land in `acp_events` and replay over the WS. This is the program's first real cross-harness conversation — record the transcript excerpt in the PR.
  4. Confirm forward-compat: superchotu/superprocess nodes (old binaries, no acp) still list/adopt fine against the new hub.
- [ ] Merge on green + verified; update `acp-sessions-program` memory.

## Self-Review Notes

- Carry-ins covered: #1 (reconcileOnBoot + endSession acp.close), #2 (Task 1 CapabilityList), #3 (Task 1 doc), #4 (single-session-per-station + fresh-process refusal), #5 (n/a hub), #6 (WS write deadlines remain node-side — NOT covered here; keep on ledger).
- SDK symbol names deliberately unspecified (fluent `client()` API; implementer reads installed d.ts) — the contracts pinned are ours: AcpWire, service functions, WS message schemas.
- Console UI intentionally absent (slice 3). Single-session-per-station is a slice-2 simplification; multi-session is slice 4.
