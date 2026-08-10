# ACP Slice 4b — Multiple Sessions Per Station Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A station can host several concurrent ACP sessions, so you can run more than one conversation with the same agent — and the console lets you switch between them.

**Architecture:** The blocker is node-side, not hub-side. The node-agent's ACP manager is idempotent **by station key** (`internal/acp/manager.go`), and stdin/stdout are fanned out per node session id, so two hub sessions on one station today would share one child process and read each other's JSON-RPC traffic. This slice gives `acp.open` an optional **instance discriminator** so each hub session gets its own process, negotiates that capability honestly (an older node that ignores the field must not silently cause cross-talk), relaxes the hub's one-live-session-per-station guard, and adds a session switcher to the chat header.

**Tech Stack:** Go (node-agent), zod contract, Bun/Hono/Drizzle hub, Svelte 5 console.

## Global Constraints

- **Forward/backward compatibility is a correctness requirement, not politeness.** A new hub talking to an old node must NOT open a second session that shares a process — that would cross-wire two conversations. The node signals support by echoing the instance back in the `acp.open` result; when the echo is missing the hub keeps today's single-session behaviour for that station (the existing 409 + copy). Slice-1 already proved the reverse hazard is real: an old hub rejected detect responses carrying an unknown capability.
- Session identity on the wire stays as it is: input frames are keyed by the **node** session id (`acp.open`'s returned `sessionId`), and the hub's own `acp_sessions.id` is separate. Don't conflate them.
- The hub's existing safety rails must survive: the 30s handshake deadline, the offline grace park at `waiting`, `reconcileOnBoot`, and `closeOrphanedProcesses` on node reconnect. With unique processes per session, each row's `node_session_id` is now genuinely unique — verify no code still assumes one per station.
- Console: sessions are hub-owned. Switching sessions must not end any of them; closing the tab still only unsubscribes.
- Copy grammar `Couldn't <verb> <object>.`; design system only (`<Status>`, type roles, status tokens); keyboard-complete; one status live region (the chat header owns it — a second would double-announce).
- Keep `busy` exactly equal to `AcpChat.prompt()`'s refusal rule when the controller gains session switching; a refused send must never destroy the draft.
- Go test hygiene: no unreaped children whose `comm` matches a pgrep target; prefer injectable seams over spawning real processes.
- Commit trailers on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01TbNjcG9KvVyeLFSZcXu8HB`

## File Structure

```
packages/contract/src/protocol.ts (or wherever VERB_PARAMS/VERB_RESULTS live)  acp.open gains optional instance + echoed instance in the result
apps/node-agent/internal/acp/manager.go        key on (stationKey, instance); keep no-instance behaviour identical
apps/node-agent/internal/gateway/acp.go        read instance from params, echo it in the result
apps/hub/src/services/acp-transport.ts         send a unique instance; surface whether the node echoed it
apps/hub/src/services/acp-sessions.ts          liveByStation: one → many; guard only when the node lacks instance support
apps/hub/src/routes/station-acp.ts             409 only in the degraded case
apps/console/src/lib/api/acp.ts                (only if the session list needs new shapes)
apps/console/src/lib/components/stations/chat/acp-chat.svelte.ts   attach(sessionId) + explicit create
apps/console/src/lib/components/stations/chat/ChatHeader.svelte    session switcher
apps/console/src/lib/components/stations/chat/ChatPanel.svelte     own the selected session id
```

---

### Task 1: Contract — `acp.open` instance discriminator

**Files:**
- Modify: the contract module defining the ACP verb params/results (find it: `packages/contract/src/` — the slice-1 verbs `acp.open`/`acp.attach`/`acp.close` live with the other station verbs)
- Test: the contract's existing verb test file

**Interfaces produced (consumed by Tasks 2–4):**
- `acp.open` params gain `instance?: string` — an opaque, caller-chosen discriminator. Absent means "legacy: reuse any existing process for this key".
- `acp.open` result gains `instance?: string` — a node that understands the field **echoes it back**. Absence is the hub's signal that the node is old.

- [ ] **Step 1 (RED):** extend the verb schema tests: params parse with and without `instance`; a result carrying `instance` parses; a result without it still parses (old nodes).
- [ ] **Step 2:** run the contract suite → FAIL. **Step 3:** implement. **Step 4:** `cd packages/contract && bun test` green.
- [ ] **Step 5:** Commit `feat(contract): acp.open instance discriminator`.

---

### Task 2: node-agent — per-instance ACP processes

**Files:**
- Modify: `apps/node-agent/internal/acp/manager.go`, `apps/node-agent/internal/gateway/acp.go`
- Test: `apps/node-agent/internal/acp/manager_test.go`, `apps/node-agent/internal/gateway/dispatch_acp_test.go`

**Interfaces:**
- Consumes: Task 1's optional `instance`.
- Produces: `Manager.Open(key, instance string, argv []string, dir string, env []string) (*Session, error)` — keyed on the pair. `instance == ""` keeps **exactly** today's behaviour (idempotent by key), because that is what an old hub sends. The gateway's `handleOpen` reads `instance` from the params and includes it in the result map alongside `sessionId`.

- [ ] **Step 1 (RED):** tests — two `Open` calls with the same key and *different* instances yield two distinct sessions with distinct ids and distinct processes; same key + same instance is idempotent (returns the identical session); empty instance twice is idempotent (the legacy contract, which `dispatch_acp_test.go`'s `TestACPVerbs` already encodes — extend rather than break it); `handleOpen` echoes the instance it was given and omits it when none was sent; `OnExit` unregisters the right (key, instance) entry and leaves its sibling alive.
- [ ] **Step 2:** `cd apps/node-agent && go test ./internal/acp/ ./internal/gateway/ -run 'ACP|Manager' -v` → FAIL.
- [ ] **Step 3:** implement. `byKey map[string]string` becomes keyed by a composite (e.g. `key + "\x00" + instance`) — keep the reverse-scan `remove` correct for the new key shape, and keep the lost-race branch (`manager.go:73-80`) that closes the losing child.
- [ ] **Step 4:** `go test -race ./...` green.
- [ ] **Step 5:** Commit `feat(node-agent): one acp process per session instance`.

---

### Task 3: Hub transport — send an instance, report support

**Files:**
- Modify: `apps/hub/src/services/acp-transport.ts`
- Test: `apps/hub/tests/` (the acp wire tests + `tests/helpers/acp-fake-node.ts`)

**Interfaces:**
- `openAcpWire(nodeId, stationKey)` sends a fresh `instance` (a uuid) on `acp.open` and returns it alongside the existing `AcpWire` fields, plus `instanceEchoed: boolean` — `true` only when the node's result echoed the instance. Extend `AcpWire` rather than changing its existing field meanings; `nodeSessionId` still keys input frames.
- The fake node gains a switch to simulate an **old** node (accepts `acp.open`, returns only `sessionId`), because Task 4's degraded path needs it.

- [ ] **Step 1 (RED):** tests — the open frame carries a non-empty `instance`; two `openAcpWire` calls for one station send different instances; `instanceEchoed` is true against the modern fake and false against the legacy fake.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** hub suite green (`DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test`).
- [ ] **Step 5:** Commit `feat(hub): acp wire sends a per-session instance`.

---

### Task 4: Hub service + routes — many live sessions per station

**Files:**
- Modify: `apps/hub/src/services/acp-sessions.ts`, `apps/hub/src/routes/station-acp.ts`
- Test: `apps/hub/tests/acp/…` (the service + route suites)

**Interfaces:**
- `liveByStation` becomes one-to-many (`Map<string, Set<LiveSession>>`). `finalizeEnd`'s delete is already identity-guarded — make it remove from the set and drop the key when empty.
- `createSession` no longer refuses a second session **when the node echoed the instance**. When it did not (old node), keep today's behaviour verbatim: throw the existing `"An active session already exists for this agent."`, which `station-acp.ts`'s `createErrorStatus` maps to 409. The degraded path must be reached by a real signal from the wire, never by a version guess.
- `listSessions` gains SQL ordering (`lastEventAt desc, id desc`) so the console's switcher and slice 4c's history share one ordered read; drop the route's JS sort.

- [ ] **Step 1 (RED):** tests — two concurrent sessions on one station both reach `idle` and stream independently (assert with the fake node that each got its own instance and that a prompt in session A never appears in B's transcript); an old node still 409s on the second create; ending one session leaves the other live and its process untouched; `reconcileOnBoot` and `closeOrphanedProcesses` close **each** row's own `node_session_id` and never one that belongs to a live sibling.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** hub suite green.
- [ ] **Step 5:** Commit `feat(hub): multiple live acp sessions per station`.

---

### Task 5: Console — session switcher

**Files:**
- Modify: `apps/console/src/lib/components/stations/chat/acp-chat.svelte.ts`, `ChatHeader.svelte`, `ChatPanel.svelte`; `apps/console/src/lib/api/acp.ts` only if needed
- Test: the colocated `.svelte.test.ts` files for each

**Interfaces:**
- `AcpChat` gains `attach(sessionId: string): Promise<void>` (tear down the current socket, reset the transcript, subscribe to the given session) and `sessions: AcpSessionRow[]` (the station's sessions, newest first, refreshed on create/end). `init()` keeps its current behaviour of attaching the newest non-ended session. `newSession()` becomes an explicit create rather than a local reset — but creation stays lazy-on-first-prompt if that is simpler to keep `busy` honest; whichever you choose, document it in the class doc comment.
- `ChatHeader` gains a session selector (a `<Select>` from `ui/select`, or chips if there are few) listing the station's sessions by relative last-activity with their `<Status>`; picking one calls `onSelectSession(id)`. Keep exactly one status live region.
- `ChatPanel` owns the selected session id and re-attaches on change. Do NOT remount the whole panel per session (the socket lifecycle is the controller's job) — but DO reset the composer draft state deliberately, and say which way you chose.

- [ ] **Step 1 (RED):** tests — the switcher lists the station's sessions and switching calls `attach` (assert the new socket subscribes to the new id and the old socket closes); switching does NOT DELETE anything (assert zero DELETE fetches); the transcript swaps to the new session's replay; "New session" adds a session and selects it; with one session the switcher stays out of the way (renders nothing or a single inert label — pick and assert).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `pnpm check && pnpm test && pnpm build` green.
- [ ] **Step 5:** Commit `feat(console): switch between an agent's sessions`.

---

### Task 6: Slice gate — suites, PR, CI, live verification (controller-run)

- [ ] All four suites green (contract, hub with the `:5434` DATABASE_URL override, node-agent `-race`, console check+test+build).
- [ ] Push; PR `feat: ACP slice 4b — multiple sessions per agent`; CI green; merge.
- [ ] Deploy: hub (`git pull` + `bun x pnpm@10 install --frozen-lockfile --filter @agentpod/hub...` + restart — plain `bun install` is a silent no-op on the box), console (`PUBLIC_HUB_URL=https://hub.agentpod.dev pnpm --filter @agentpod/console build` then `wrangler pages deploy apps/console/build --project-name agentpod-console --branch main`; the Pages git integration does not auto-build), and the node-agent to at least one node.
- [ ] Live: open two concurrent sessions on one station (opencode-one is the reliable one — hermes works too), confirm each holds its own conversation with no cross-talk, switch between them in the header, end one and confirm the other survives with its process intact, then end the second and confirm no remnants.
- [ ] Live degraded path: against a node still running an older binary, confirm a second create returns 409 with the existing copy rather than silently sharing a process.
- [ ] Update the `acp-sessions-program` memory; ledger complete.

## Self-Review Notes

- The instance echo is the whole compatibility story: without it, a new hub plus an old node produces two sessions on one process and two conversations bleeding into each other. That is why Task 3 teaches the fake node to play old.
- Per-session processes are deliberately chosen over multiplexing several ACP `session/new` ids inside one process. Multiplexing is cheaper and both OpenClaw and the Claude Code adapter support it, but it would require routing every `session/update` by `params.sessionId` (today ignored) and would make one crashed process take out every conversation on that station. Revisit if process count becomes a real cost.
- The hub's handshake deadline (30s) was added because a hung handshake used to 409-lock a station. With multi-session that pressure drops, but keep the deadline — a wedged process still deserves to fail fast.
- Slice 4c (history) will reuse `listSessions`' new SQL ordering and the same `Conversation` component in a read-only mode; don't build a second list read path here.
