# ACP Slice 4c — Session History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Past conversations with an agent are findable and readable — labelled by what they were about, not just when they happened.

**Architecture:** Slice 4b already gives every station many sessions, a SQL-ordered list, and a switcher that can attach an ended session read-only. What's missing is meaning and scale: rows say "Session 3 · ended · 2h ago", the list is uncapped, and the transcript read path is the live WebSocket. This slice denormalizes a `title` from each session's first prompt, tracks `lastSeq` so a row can show its size, caps and paginates the list, and gives the console a proper history surface. No new read path: the existing WS `subscribe` already replays ended sessions correctly, and reusing it keeps one code path.

**Tech Stack:** zod contract, Drizzle/Postgres migration, Bun/Hono hub, Svelte 5 console.

## Global Constraints

- **Additive contract only.** `AcpSessionRow` gains optional fields; a console built before this slice must still parse rows from the new hub, and the new console must tolerate a row without them (the hub and console deploy separately — the Pages build is a manual step).
- The migration is `0026_*` (latest on disk is `0025_striped_demogoblin.sql`). Generate it with drizzle-kit (`generate`, then the SQL + meta snapshot land together) — never hand-write the journal.
- **Title is derived, never authoritative.** It's a denormalized convenience: set it once from the first `user-prompt` of a session and never rewrite it. Truncate at a fixed width, store the truncation, and don't try to summarize.
- Titles are **untrusted user/agent text**: the console must render them as text (no HTML), truncate visually, and handle empty/whitespace-only.
- Keep every invariant earlier slices paid for: `busy` is exactly `prompt()`'s refusal rule; switching/reading never ends a session (zero DELETEs); exactly one status live region (the chat header); pending optimistic prompts resolved on every path; kind-prefixed keyed lists with unique negative seqs for synthetic items.
- Copy grammar `Couldn't <verb> <object>.`; design-system components only; keyboard-complete; reduced-motion respected.
- Hub tests need the explicit override: `DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test`.
- Commit trailers on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01TbNjcG9KvVyeLFSZcXu8HB`

## File Structure

```
packages/contract/src/acp-session.ts              AcpSessionRow += title?, lastSeq?
apps/hub/src/db/schema/acp.ts                     acp_sessions += title, lastSeq; index (stationId, lastEventAt desc)
apps/hub/src/db/drizzle-migrations/0026_*.sql      generated
apps/hub/src/services/acp-sessions.ts             set title on first prompt; maintain lastSeq; listSessions limit/cursor
apps/hub/src/routes/station-acp.ts                list route takes ?limit=&before=
apps/console/src/lib/api/acp.ts                   listAcpSessions gains paging args
apps/console/src/lib/components/stations/chat/ChatHeader.svelte    titled rows, capped switcher + "All sessions…"
apps/console/src/lib/components/stations/chat/SessionHistory.svelte  NEW: full list surface
apps/console/src/lib/components/stations/chat/ChatPanel.svelte     history wiring + the draft-prune fix
```

---

### Task 1: Contract + schema + migration

**Files:**
- Modify: `packages/contract/src/acp-session.ts`, `apps/hub/src/db/schema/acp.ts`
- Create: `apps/hub/src/db/drizzle-migrations/0026_*.sql` (+ meta snapshot, via drizzle-kit)
- Test: the contract's acp-session test file; `apps/hub/tests/unit/acp.schema.test.ts` if it asserts row shape

**Interfaces produced (consumed by Tasks 2–3):**
```ts
// AcpSessionRow gains, both optional for cross-version tolerance:
title: z.string().nullable().optional()   // first prompt, truncated; null until the first prompt
lastSeq: z.number().int().optional()      // highest event seq persisted for the session
```
DB: `acp_sessions.title text` (nullable), `acp_sessions.last_seq integer NOT NULL DEFAULT 0`, plus `index acp_sessions_station_activity_idx on (station_id, last_event_at desc)`.

- [ ] **Step 1 (RED):** contract tests — a row WITH title/lastSeq parses; a row WITHOUT them parses (old hub); `title: null` parses; a non-integer lastSeq is rejected.
- [ ] **Step 2:** `cd packages/contract && bun test` → FAIL. **Step 3:** implement schema + contract, then generate the migration with drizzle-kit and verify `0026_*.sql` contains exactly the two columns and the index (no unrelated churn — if drizzle wants to emit anything else, stop and report it).
- [ ] **Step 4:** contract green; `DATABASE_URL=… bun test` in apps/hub green (migrations auto-apply on boot, so the suite exercises the new migration).
- [ ] **Step 5:** Commit `feat(contract): acp session title + lastSeq`.

---

### Task 2: Hub — title, lastSeq, paginated list

**Files:**
- Modify: `apps/hub/src/services/acp-sessions.ts`, `apps/hub/src/routes/station-acp.ts`
- Test: the acp service + route suites

**Interfaces:**
- `persistEvent` maintains `last_seq` on the session row in the same write it already does for `last_event_at` — one statement, not a second round trip.
- On the FIRST `user-prompt` of a session (title still null), set `title` to that prompt trimmed and truncated to **80 characters** (store the truncation; append no ellipsis — that's the console's presentation choice). Whitespace-only prompts leave it null.
- `listSessions(userId, stationId, opts?: { limit?: number; before?: string })` — `limit` defaults to 20 and is clamped to 100; `before` is a `lastEventAt` ISO cursor for "older than". Ordering stays `lastEventAt desc, id desc`. Returns rows plus enough to page.
- The list route accepts `?limit=` and `?before=`, validated with zod, and rejects nonsense with 400 rather than silently clamping to a default (clamping the *value* is fine; a non-numeric limit is a client bug worth surfacing).

- [ ] **Step 1 (RED):** tests — first prompt sets the title, a second prompt does NOT rewrite it; an 81+ char prompt is stored truncated to 80; a whitespace-only prompt leaves title null; `lastSeq` tracks the highest seq across prompts/updates/state and survives an end; `limit` caps and clamps; `before` returns strictly older rows and paginates without duplicates or gaps across two pages; a bad `limit` is 400.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** hub suite green.
- [ ] **Step 5:** Commit `feat(hub): session titles, lastSeq, paginated session list`.

---

### Task 3: Console — titled switcher, history surface, draft fix

**Files:**
- Modify: `apps/console/src/lib/api/acp.ts`, `chat/ChatHeader.svelte`, `chat/ChatPanel.svelte`
- Create: `chat/SessionHistory.svelte`
- Test: colocated `.svelte.test.ts` for the new component and the two modified ones

**Interfaces:**
- `listAcpSessions(stationId, opts?: { limit?: number; before?: string })`.
- `ChatHeader`: rows read `title` when present (falling back to today's "Session N"), truncated with `line-clamp`/`truncate` and `min-w-0`, status and relative activity kept. The switcher lists at most **8** sessions; when more exist it ends with an "All sessions…" item that calls `onOpenHistory()`.
- `SessionHistory.svelte`: props `{ stationId, currentSessionId, onSelect(id), onClose }`. A `Dialog` (the repo's established list→detail idiom is routing, but a dialog keeps the chat mounted and is the smaller change — `ui/sheet` exists unused; pick Dialog and say why in a comment). Shows the paginated list with title, `<Status>`, relative last activity and event count from `lastSeq`; a "Load older" control drives the `before` cursor; `<Empty>` when a station has no sessions; selecting a row calls `onSelect` and closes.
- `ChatPanel`: owns history open/closed, passes `onOpenHistory`, and routes `onSelect` through the SAME `selectSession`/`settleOn` path the switcher uses (do not add a second attach path — that's how the header went stale in 4b).
- **Fix carried from 4b's review:** typing into an already-ended session and then clicking "New session" parks the draft under the ended session's slot, which the pruning effect garbage-collects — the text is lost. Park it under the `NEW_SESSION_SLOT` sentinel instead whenever the session being left is ended, so it survives into the next created session. Regression test required.

- [ ] **Step 1 (RED):** tests — a titled session renders its title, an untitled one falls back; a 9th session collapses the switcher to 8 + "All sessions…"; opening history lists rows and "Load older" requests the next page with a `before` cursor; selecting from history attaches via the shared path (assert the new socket subscribes and the header names the selected session); history issues ZERO DELETEs; the ended-session draft survives "New session".
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `pnpm check && pnpm test && pnpm build` green.
- [ ] **Step 5:** Commit `feat(console): session history with titles`.

---

### Task 4: Slice gate — suites, PR, CI, live verification (controller-run)

- [ ] Four suites green (contract; hub with the `:5434` override; node-agent `-race`; console check+test+build).
- [ ] Push; PR `feat: ACP slice 4c — session history`; CI green; merge.
- [ ] Deploy: hub (`git pull` + `bun x pnpm@10 install --frozen-lockfile --filter @agentpod/hub...` + restart — plain `bun install` is a silent no-op on the box) and console (`PUBLIC_HUB_URL=https://hub.agentpod.dev pnpm --filter @agentpod/console build`, then `wrangler pages deploy apps/console/build --project-name agentpod-console --branch main`; the Pages git integration does not auto-build). No node-agent change in this slice.
- [ ] Live: on a station with several sessions (hermes:buddhimaan or openclaw:hanuman, both known good), confirm new prompts produce titled rows, older sessions keep their titles, the switcher caps and "All sessions…" opens the history list, "Load older" pages, and selecting an ended session opens it read-only with the ended notice. Verify the migration applied by reading a row's title/last_seq on the box.
- [ ] Update the `acp-sessions-program` memory; ledger complete.

## Self-Review Notes

- No new transcript read path: the WS `subscribe` already replays an ended session then sends `bye`, and it is ownership-checked. A REST events endpoint would be a second thing to secure and keep consistent for no gain here.
- `lastSeq` is maintained in the write that already touches the row, so history can show size without a `COUNT(*)` per session — the reason the schema review flagged it in the first place.
- Titles are set once and never rewritten, so a long conversation keeps the label the user recognizes rather than drifting to whatever was said last.
- Pagination uses a `lastEventAt` cursor rather than OFFSET because the ordering key changes as sessions stream — OFFSET would skip or repeat rows mid-scroll.
