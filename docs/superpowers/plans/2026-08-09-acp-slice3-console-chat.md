# ACP Slice 3 — Console Chat Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A world-class Chat tab on the station page that drives any `acp`-capable agent through the hub's slice-2 session API — streamed markdown, reasoning blocks, tool-call cards, inline permission prompts, replayable hub-owned sessions.

**Architecture:** A thin WS/REST client factory (`api/acp.ts`, mirroring `terminal.ts`), a pure event→transcript projection module, and a per-panel session controller class (`AcpChat`) feed a component tree (Conversation / Response / Reasoning / ToolCallCard / PermissionCard / PromptInput / ChatHeader) composed by `ChatPanel`. Sessions are hub-owned: closing the tab only unsubscribes; reattach replays from the last seen seq.

**Tech Stack:** Svelte 5 runes, `svelte-streamdown` (new dep) for streaming markdown + shiki code, existing Crisp design system (`<Status>`, type roles, status tokens, `chipClass`), `@agentpod/contract` ACP schemas, vitest + testing-library with the house `MockWebSocket` pattern.

## Global Constraints

- The chat experience must be world-class (user directive) — no placeholder UX, no deferred core interactions.
- Copy grammar for every failure: `Couldn't <verb> <object>.` (e.g. "Couldn't reach the hub — check your connection.").
- Design system only: `<Status>` for all status display (never raw colored dots), type roles `t-page/t-section/t-body/t-label/t-metric`, status tokens via `tokenFor()` — no ad-hoc colors except where a task explicitly says otherwise.
- Session semantics (hub-owned): client disconnect only unsubscribes — never treat a WS close as session end; only `bye` or a `state: ended` event ends the session in the UI.
- Synthetic error events arrive with `seq: 0` — they must NEVER advance the replay cursor. The cursor is the max seq of REAL (seq ≥ 1) events seen; do not trust `replay-done.lastSeq` as server max (it echoes bogus client cursors).
- `renderHtml` stays OFF in streamdown (agent output is untrusted).
- Accessibility: reduced-motion respected (`motion-safe:` on pulses/animations), `aria-live="polite"` for turn/permission updates, all interactions keyboard-complete, icon-only buttons get `aria-label`.
- Svelte conventions: runes (`$state`/`$derived`/`$effect`), `$props()` with local `interface Props`, plain `let` for refs needed in `onDestroy`.
- Tests: static-import components under test; install `MockWebSocket` on `globalThis` BEFORE importing modules that capture it; never remove the vitest-setup scroll-lock teardown; stub heavy children (`streamdown`, monaco) with `.stub.svelte` files.
- Hub API (slice 2, live): `POST /api/stations/:id/acp/sessions {mode}` → 201 `AcpSessionRow`; `GET /api/stations/:id/acp/sessions` → rows newest-first; `DELETE /api/acp/sessions/:sessionId` → 204; WS `/api/acp/sessions/:sessionId/ws` speaking `AcpClientMsg`/`AcpServerMsg` from `@agentpod/contract`.
- Commit trailers on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01TbNjcG9KvVyeLFSZcXu8HB`

## File Structure

```
apps/console/src/lib/api/acp.ts                       REST calls + createAcpSocket factory
apps/console/src/lib/api/acp.test.ts
apps/console/src/lib/components/stations/chat/
  transcript.ts                                       pure AcpEvent[] → ChatItem[] projection
  transcript.test.ts
  acp-chat.svelte.ts                                  AcpChat controller class (runes)
  acp-chat.svelte.test.ts
  Response.svelte                                     streamdown wrapper
  Reasoning.svelte                                    collapsible thinking block
  ToolCallCard.svelte
  PermissionCard.svelte
  Conversation.svelte                                 transcript list + follow mechanics
  PromptInput.svelte
  ChatHeader.svelte                                   mode selector, status, end session
  ChatPanel.svelte                                    composition root, props { stationId }
  response.stub.svelte                                test stub for streamdown
  *.svelte.test.ts                                    colocated component tests
apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte   Chat tab wiring
```

---

### Task 1: ACP API client (`api/acp.ts`)

**Files:**
- Create: `apps/console/src/lib/api/acp.ts`
- Test: `apps/console/src/lib/api/acp.test.ts`

**Interfaces:**
- Consumes: `http<T>` is NOT reused — mirror `terminal.ts`'s standalone pattern for the WS; REST goes through the existing `client.ts` conventions (add the three functions THERE or here — put them here, importing `hubUrl`-equivalent logic the same way `terminal.ts` does; REST error handling reuses `http-error.ts` via a local `http`-style helper or by importing and calling `apiError`/`networkError`. Simplest: import the private pattern — copy the 20-line `http<T>` shape locally, or export `http` from `client.ts` and import it. **Do: export `http` from `client.ts`** (one-line `export` keyword change) and import it.)
- Produces (used by Task 3):
  ```ts
  export type AcpSessionRow = import("@agentpod/contract").AcpSessionRow;
  export type AcpServerMsg = import("@agentpod/contract").AcpServerMsg;
  export type AcpClientMsg = import("@agentpod/contract").AcpClientMsg;
  export const createAcpSession: (stationId: string, mode: AcpSessionMode) => Promise<AcpSessionRow>;
  export const listAcpSessions: (stationId: string) => Promise<AcpSessionRow[]>;
  export const endAcpSession: (sessionId: string) => Promise<void>;   // DELETE, 204
  export interface AcpSocket {
    send(msg: AcpClientMsg): void;          // queues until open, mirrors terminal.ts sendQueue
    onMessage(cb: (msg: AcpServerMsg) => void): void;
    onClose(cb: (reason: "error" | "closed") => void): void;  // suppressed after close()
    close(): void;                           // manualClose — never fires onClose
  }
  export function createAcpSocket(sessionId: string): AcpSocket;
  ```
- WS URL: `${hubUrl().replace(/^http/, "ws")}/api/acp/sessions/${sessionId}/ws` — same `hubUrl()` resolution as `terminal.ts:14-18` (localStorage override → `PUBLIC_HUB_URL` → localhost:3001).
- Inbound messages are parsed with `AcpServerMsg.safeParse` (zod, from contract); parse failures are dropped silently (forward compat — a newer hub may add variants).

- [ ] **Step 1 (RED):** Port the structure of `terminal.test.ts` (MockWebSocket class installed before dynamic import, localStorage URL pin). Tests: URL derivation (`ws://hub.test:3001/api/acp/sessions/s1/ws`); `send` before open queues and flushes on open in order; `onMessage` delivers parsed `AcpServerMsg` and drops garbage frames without throwing; `close()` then server close → `onClose` NOT fired; error → `onClose("error")` once; REST helpers hit the right paths/methods (spy on fetch: `POST …/acp/sessions` body `{"mode":"ask"}`, `DELETE …/api/acp/sessions/:id`).
- [ ] **Step 2:** Run `pnpm test src/lib/api/acp.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement, mirroring `terminal.ts` closely (sendQueue, manualClose, closeFired, numeric readyState literals).
- [ ] **Step 4:** `pnpm test` file green, `pnpm check` clean.
- [ ] **Step 5:** Commit `feat(console): acp session api client`.

---

### Task 2: Transcript projection (`chat/transcript.ts`)

**Files:**
- Create: `apps/console/src/lib/components/stations/chat/transcript.ts`
- Test: `apps/console/src/lib/components/stations/chat/transcript.test.ts`

Pure module: fold persisted/live `AcpEvent`s into renderable items. No Svelte imports.

**Interfaces (produced, consumed by Tasks 3/6):**
```ts
export type ChatItem =
  | { kind: "user"; seq: number; text: string; pending?: boolean }
  | { kind: "assistant"; seq: number; text: string; streaming: boolean }
  | { kind: "reasoning"; seq: number; text: string; streaming: boolean }
  | { kind: "tool"; seq: number; toolCallId: string; title: string; toolKind?: string;
      status: "pending" | "in_progress" | "completed" | "failed";
      content: Array<{ type: "text"; text: string } | { type: "diff"; path: string; oldText: string | null; newText: string }>;
      locations: string[] }
  | { kind: "permission"; seq: number; requestSeq: number; title: string; toolKind?: string;
      options: Array<{ optionId: string; name: string; kind: string }>;
      answer?: { optionId?: string; cancelled?: boolean; auto?: boolean } }
  | { kind: "notice"; seq: number; level: "info" | "error"; text: string };  // ended reasons, errors

export interface Transcript { items: ChatItem[]; lastSeq: number; status: AcpSessionStatus; usage?: { used: number; size: number } }
export function emptyTranscript(): Transcript;
export function foldEvent(t: Transcript, ev: AcpEvent): Transcript;   // pure; returns new object, reuses untouched item refs
```

Folding rules (payload shapes verified live on hermes/opencode, hub `acp-sessions.ts`):
- `user-prompt {text}` → close any open assistant/reasoning item (streaming→false), push `user`. If the last item is a `user` with `pending: true`, REPLACE it (optimistic reconcile) instead of pushing.
- `agent-update` — switch on `payload.sessionUpdate`:
  - `agent_message_chunk {content:{type:"text",text}}` → append text to trailing `assistant` item if it is `streaming`, else push new one.
  - `agent_thought_chunk` → same, on `reasoning` items.
  - `tool_call {toolCallId, title, kind?, status?, content?, locations?}` → push `tool` item (status default `pending`; map `content` entries: `{type:"content", content:{type:"text",text}}` → text; `{type:"diff", path, oldText, newText}` → diff; ignore unknown types; `locations` → `loc.path` strings).
  - `tool_call_update {toolCallId, …}` → merge into the matching `tool` item (later fields win; content replaces when present); unknown toolCallId → ignore.
  - `plan`, `available_commands_update`, `current_mode_update` → ignore (v1).
  - `usage_update {used, size}` → set `t.usage`, no item.
  - unknown `sessionUpdate` → ignore (forward compat).
- `permission-request {toolCall, options}` at seq S → push `permission` (requestSeq = S, title from `toolCall.title` ?? tool name, options mapped).
- `permission-answer {requestSeq, optionId?, cancelled?, auto?}` → set `answer` on the matching permission item.
- `state {status, reason?}` → `t.status = status`; `ended` additionally pushes `notice` (`info`, text `reason` ? \`Session ended — ${reason}\` : "Session ended."); non-ended states push nothing.
- `error {message}` (persisted type `"error"`, or synthetic seq-0 relayed by caller) → push `notice` level `error` with the message.
- Cursor: `lastSeq = max(lastSeq, ev.seq)` ONLY when `ev.seq >= 1`. Duplicate delivery (ev.seq ≤ lastSeq for seq ≥ 1 events) → return `t` unchanged (idempotent).
- Optimistic prompt helper: `export function addPendingPrompt(t: Transcript, text: string): Transcript` — pushes `user` with `seq: -1, pending: true`.

- [ ] **Step 1 (RED):** Fixture-driven tests: (a) the live-observed opencode sequence (state idle → agent-update available_commands → user-prompt → state working → 7 message chunks "ACP"…"OK" → usage_update → state idle) folds to [user, assistant("ACP-SLICE2-OK" complete)] with status idle, usage set, lastSeq correct; (b) reasoning chunks interleaved with message chunks produce separate items in arrival order; (c) tool_call + two tool_call_updates merge (status pending→in_progress→completed, diff content); (d) permission request+answer roundtrip incl. `cancelled:true` and `auto:true`; (e) duplicate seq delivery is a no-op; seq-0 error event adds notice but does NOT move lastSeq; (f) ended state appends notice with reason; (g) optimistic pending prompt is replaced by the real user-prompt event (not duplicated).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** file + `pnpm check` green.
- [ ] **Step 5:** Commit `feat(console): acp transcript projection`.

---

### Task 3: Session controller (`chat/acp-chat.svelte.ts`)

**Files:**
- Create: `apps/console/src/lib/components/stations/chat/acp-chat.svelte.ts`
- Test: `apps/console/src/lib/components/stations/chat/acp-chat.svelte.test.ts`

**Interfaces:**
- Consumes: Task 1 (`createAcpSession/listAcpSessions/endAcpSession/createAcpSocket`), Task 2 (`emptyTranscript/foldEvent/addPendingPrompt`).
- Produces (consumed by Tasks 6/7): class `AcpChat`, one instance per ChatPanel:
  ```ts
  export class AcpChat {
    constructor(stationId: string);
    // reactive ($state-backed) getters:
    readonly session: AcpSessionRow | null;
    readonly transcript: Transcript;             // items, status, usage, lastSeq
    readonly connection: "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";
    readonly error: string | null;               // last surfaced failure, "Couldn't …" copy
    readonly working: boolean;                    // transcript.status === "working"
    readonly pendingPermissions: number;
    mode: AcpSessionMode;                        // selector state; defaults "ask", synced from session row
    init(): Promise<void>;      // list sessions; if newest is non-ended → attach; else stay idle (empty state)
    prompt(text: string): Promise<void>;  // creates session first if none (mode = this.mode), optimistic item, sends {t:"prompt"}
    cancel(): void;                        // {t:"cancel"}
    answer(requestSeq: number, optionId: string | null): void; // {t:"permission-answer", requestSeq, optionId?…} null → cancelled:true
    setMode(mode: AcpSessionMode): void;   // {t:"set-mode"} + local
    end(): Promise<void>;                  // REST DELETE; UI settles on bye/ended event
    newSession(): void;                    // after ended: reset to empty state (keep nothing)
    retry(): void;                         // manual reconnect, resets backoff budget
    destroy(): void;                       // close socket; never ends the session
  }
  ```
- Attach protocol: open socket → `subscribe {sinceSeq: transcript.lastSeq}` → apply `session` msg (row), fold `event`s, `replay-done` marks connection "connected" (before it, "connecting"/"reconnecting"). `bye {reason}` → session over: fold a final ended notice if none arrived, connection "idle", no reconnect.
- Reconnect: on non-manual close with a live session, budget of 3 attempts, backoff [1000, 2000, 4000] (mirror Terminal.svelte); re-subscribe uses current `lastSeq` (replay fills the gap — this is the "working while away" path). Budget exhausted → connection "disconnected", `error = "Couldn't reach the hub — check your connection."`; `retry()` resets.
- Synthetic seq-0 `error` events: fold (notice) but they never advance the cursor (Task 2 guarantees); ALSO set `this.error` when the session has no live turn (so the input area can surface it).

- [ ] **Step 1 (RED):** With MockWebSocket + `vi.spyOn` on the api module: (a) `init` with an active session row attaches and replays (events → items, connected after replay-done); (b) `init` with only ended sessions stays idle, no socket; (c) `prompt` with no session: POST create → socket → subscribe → prompt sent, optimistic item visible then reconciled by the echoed user-prompt event; (d) unexpected close mid-session → reconnecting, new socket subscribes with `sinceSeq = lastSeq`; 3 failures → disconnected + error copy; `retry()` reconnects; (e) `bye` → no reconnect attempt, status ended; (f) `answer(seq, null)` sends `{cancelled: true}`; (g) `destroy()` closes without DELETE (hub-owned — assert no fetch to DELETE); (h) `end()` calls DELETE and the ended state arrives via events, not locally forced.
- [ ] **Step 2:** FAIL. **Step 3:** implement (module-level nothing — all instance state; `$state` fields + getters). **Step 4:** green + `pnpm check`.
- [ ] **Step 5:** Commit `feat(console): acp chat session controller`.

---

### Task 4: Response + Reasoning components

**Files:**
- Modify: `apps/console/package.json` (add `svelte-streamdown`, exact version, latest)
- Create: `chat/Response.svelte`, `chat/Reasoning.svelte`, `chat/response.stub.svelte`
- Test: `chat/Response.svelte.test.ts`, `chat/Reasoning.svelte.test.ts`

Install: `pnpm add -E svelte-streamdown --filter @agentpod/console` (run from repo root).

**Response.svelte** — `interface Props { text: string; streaming?: boolean }`:
```svelte
<script lang="ts">
  import { Streamdown } from "svelte-streamdown";
  import Code from "svelte-streamdown/code";
  import { themeStore } from "$lib/themes/store.svelte";
  let { text, streaming = false }: Props = $props();
  const shikiTheme = $derived(themeStore.shikiThemes /* pick current color-scheme name; check store API — it exposes light/dark theme names */);
</script>
<Streamdown content={text} components={{ code: Code }} baseTheme="tailwind"
  parseIncompleteMarkdown={streaming} renderHtml={false}
  allowedLinkPrefixes={["https://", "http://"]} shikiTheme={/* resolved name */}
  theme={{ /* map container/prose text to t-body + Crisp borders; keep overrides minimal */ }} />
```
Verify the exact `themeStore.shikiThemes` shape (`store.svelte.ts:385-389`) and pick the theme matching the active color scheme reactively.

**Reasoning.svelte** — `interface Props { text: string; streaming?: boolean }`: `Collapsible.Root` (bits-ui passthrough at `ui/collapsible`), trigger row = `t-label` muted "Thinking" + chevron + (streaming ? `<Status form="dot" status="starting" animate label="thinking" />` : null), content = the raw text in `t-body text-muted-foreground whitespace-pre-wrap` (no markdown — thoughts are plain). Default open while `streaming`, auto-collapses when streaming flips false (an `$effect` writing `open = false` exactly once on the true→false edge — track previous with a plain let).

- [ ] **Step 1 (RED):** Reasoning test: renders trigger label; open while streaming; collapses when `streaming` prop flips; content visible after manual expand. Response test: renders markdown text (assert a `<strong>` from `**bold**` lands) — if jsdom+streamdown misbehave, the fallback assertion is that the component mounts and the container carries the text; note the outcome honestly in the report.
- [ ] **Step 2:** FAIL. **Step 3:** implement + create `response.stub.svelte` (`<div data-testid="response-stub">{text}</div>`) for later tasks. **Step 4:** green; `pnpm check`; `pnpm build` (streamdown must not break the prod build).
- [ ] **Step 5:** Commit `feat(console): chat response + reasoning components`.

---

### Task 5: ToolCallCard + PermissionCard

**Files:**
- Create: `chat/ToolCallCard.svelte`, `chat/PermissionCard.svelte`
- Test: `chat/ToolCallCard.svelte.test.ts`, `chat/PermissionCard.svelte.test.ts`

**ToolCallCard** — `interface Props { item: Extract<ChatItem, {kind:"tool"}> }`:
- Header row (always visible, is the Collapsible trigger): `<Status form="dot" …>` mapped `pending→starting`, `in_progress→starting` with `animate`, `completed→running`, `failed→error`; title in `font-mono text-sm` (agent-reported → mono per house rule); `toolKind` as `t-label` muted suffix; chevron.
- Content (collapsible, default open only while `in_progress`): text blocks in `<pre class="t-body … whitespace-pre-wrap">`; diff blocks rendered inline exactly like ConfigEditor's pattern — `diffLines(oldText ?? "", newText)` from the `diff` package, added `bg-green-500/15 text-green-700 dark:text-green-400`, removed `bg-red-500/15 … line-through`, context muted (copy the 15-line `{#each}` from `ConfigEditor.svelte:167-181`, factor it into `chat/DiffBlock.svelte` and note it as a future shared component — do NOT refactor ConfigEditor in this task); `locations` as a `t-label` file list.
- **PermissionCard** — `interface Props { item: Extract<ChatItem, {kind:"permission"}>; onAnswer: (optionId: string | null) => void }`:
  - Unanswered: bordered card, `<Status form="dot" status="starting" animate label="awaiting approval" />`, title (mono), option buttons — `kind` starting with `allow` → `variant="default"` (first) / `secondary`; `reject*` → `variant="outline"`; a separate "Dismiss" is NOT needed (reject options come from the agent). All buttons real `<Button>`, focusable, `size="sm"`.
  - Answered: muted card, chosen option name + (answer.auto ? "· auto (mode)" : "") or "Cancelled."; no buttons.
- [ ] **Step 1 (RED):** ToolCallCard: status dot mapping for all four statuses; collapsible opens by default when in_progress; diff renders added/removed lines; text content renders. PermissionCard: options render as buttons; clicking calls `onAnswer(optionId)`; answered state hides buttons and shows the chosen label; cancelled shows "Cancelled."
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** green + check.
- [ ] **Step 5:** Commit `feat(console): tool call + permission cards`.

---

### Task 6: Conversation + PromptInput + ChatHeader

**Files:**
- Create: `chat/Conversation.svelte`, `chat/PromptInput.svelte`, `chat/ChatHeader.svelte`
- Test: colocated `.svelte.test.ts` for each

**Conversation** — `interface Props { items: ChatItem[]; status: AcpSessionStatus }`:
- Scroll container (`data-testid="chat-scroll-container"`, `overflow-y-auto`), items rendered by `{#if}`/switch on `kind`: user → right-aligned bubble (`bg-primary/10 rounded-lg px-3 py-2 t-body`, `pending` → 60% opacity), assistant → `<Response>`, reasoning → `<Reasoning>`, tool → `<ToolCallCard>`, permission → `<PermissionCard>` (needs `onAnswer` — accept `onAnswer(requestSeq, optionId)` prop and curry), notice → centered `t-label` muted (error level → `text-status-error`).
- Follow mechanics copied from LogTail (L169-196): `follow = $state(true)`, `FOLLOW_THRESHOLD_PX = 40`, `queueScrollToBottom()` on items-length growth AND on trailing-item text growth (streaming), scroll-away sets follow false + counts new items, floating "N new messages" pill (reuse LogTail's pill classes) with `jumpToBottom()`.
- Each item wrapper gets `content-visibility: auto; contain-intrinsic-size: auto 4rem` (define a `.chat-item` style block).
- `aria-live="polite"` `sr-only` region announcing: latest permission request ("Agent asks to <title>") and status flips (working/idle/ended).
- Empty state (no items): `<Empty>` with title "No conversation yet." description "Send a prompt to start talking to this agent."

**PromptInput** — `interface Props { disabled?: boolean; working: boolean; onSend: (text: string) => void; onCancel: () => void }`:
- `<Textarea>` (auto-grows via existing `field-sizing-content`), placeholder `Message the agent…`, Enter sends (trimmed, non-empty; respects `event.isComposing`), Shift+Enter newline; clears on send; disabled while `disabled`.
- Right side: while `working` → stop button (`<Button variant="outline" size="icon-sm" aria-label="Stop the current turn">` square icon) calling `onCancel`; else send button (`aria-label="Send"`, disabled when empty).
**ChatHeader** — `interface Props { session: AcpSessionRow | null; status: AcpSessionStatus; connection: string; mode: AcpSessionMode; onModeChange: (m: AcpSessionMode) => void; onEnd: () => void; onNew: () => void }`:
- Left: `<Status form="dot" …>` (status vocab: working→starting+animate, idle→running, waiting→degraded, ended→stopped) + `t-label` status text, wrapped `role="status" aria-live="polite"`; connection `reconnecting/disconnected` overrides the label ("Reconnecting…" / with retry handled in panel).
- Middle: mode selector — three `chipClass`-style buttons (Ask / Accept edits / Full auto), `aria-pressed`, calls `onModeChange`; disabled when no live session (mode still selectable pre-session — it seeds creation).
- Right: session present & not ended → "End session" `<Button variant="ghost" size="sm">` opening `<ConfirmDialog>` (title "End this session?", message "The agent process stops and the transcript is kept.", destructive); ended → "New session" button calling `onNew`.
- [ ] **Step 1 (RED):** Conversation: renders each item kind (stub Response via `vi.mock` → `response.stub.svelte`); follow pill appears when scrolled away and new items arrive (jsdom: set scrollTop/scrollHeight manually like LogTail tests); aria-live region updates on permission item. PromptInput: Enter sends trimmed text and clears; Shift+Enter doesn't; empty doesn't; stop button shown while working, calls onCancel. ChatHeader: mode chips call back; End button gated behind confirm dialog; ended shows New session.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** green + check.
- [ ] **Step 5:** Commit `feat(console): chat conversation, prompt input, session header`.

---

### Task 7: ChatPanel + station page integration

**Files:**
- Create: `chat/ChatPanel.svelte`, test `chat/ChatPanel.svelte.test.ts`
- Modify: `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte`

**ChatPanel** — `interface Props { stationId: string }`:
- Instantiates `new AcpChat(stationId)` in a plain let, `onMount(() => { chat.init(); return () => chat.destroy(); })`.
- Layout: `ChatHeader` / `Conversation` (flex-1 min-h-0) / error strip / `PromptInput` in a full-height column (mirror Terminal.svelte's container sizing).
- Wiring: `onSend=chat.prompt`, `onCancel=chat.cancel`, `onAnswer=chat.answer`, mode/end/new from header; `chat.error` renders an inline strip above the input (`t-label text-status-error`) with a "Retry" `<Button variant="ghost" size="xs">` when `connection === "disconnected"`.
- First-prompt flow: no session → header shows mode chips active, conversation empty state; sending creates the session with the chosen mode (Task 3 handles it) — surface create failure via toast `toast.error("Couldn't start the session", { description })` AND the strip.
**Station page:**
- `hasAcp` capability boolean (same pattern as `hasTerminal`, L74-88).
- Tab entry `{ id: "chat", label: "Chat", icon: MessageSquareIcon }` FIRST in the tabs array when `hasAcp` (spec: first tab).
- Default tab when `?tab=` absent: `chat` if `hasAcp` else `health` — adjust the `$derived.by` fallback AND `handleTabChange`'s delete-param case (the default tab deletes the param; with `hasAcp` that's now "chat", and explicitly choosing "health" sets `?tab=health`).
- Add `"chat"` to `VALID_TABS`; render via `keepAlivePanel("chat", …)` (live WS must survive tab switches).
- [ ] **Step 1 (RED):** ChatPanel test (mock `AcpChat` module? No — mock the api layer and MockWebSocket, use the real controller; stub Response): mounts, init lists sessions, empty state renders, typing+Enter creates session and shows optimistic bubble. Station page test (new file, mirror existing route tests with reactive-page-state mock): station with `acp` capability → Chat tab first and default-active; station without → no Chat tab, health default; deep link `?tab=health` on an acp station shows health.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** full console suite `pnpm check && pnpm test` green.
- [ ] **Step 5:** Commit `feat(console): chat tab on the station page`.

---

### Task 8: Slice gate — suites, PR, CI, live verification (controller-run)

- [ ] All four suites green (contract, hub w/ :5434 DATABASE_URL, node-agent `-race`, console check+test+build).
- [ ] Push `ui-revamp`; PR `feat: ACP slice 3 — console chat` (note: branch already carries `1f2f341` small-tier fix — call it out in the PR body); CI green; merge.
- [ ] Deploy console to Cloudflare Pages with `PUBLIC_HUB_URL=https://hub.agentpod.dev` (check `.github/workflows` / `wrangler.toml` for the established deploy path — the UI milestones M1–M6 shipped through it).
- [ ] Live verification on the deployed console (browser):
  1. Chat tab appears first on `opencode-one` and on hermes stations; absent on openclaw stations.
  2. Real conversation with `hermes:buddhimaan` — streamed markdown renders, reasoning block if emitted, status flips working→idle.
  3. Permission flow: in `ask` mode prompt hermes to run a shell command → PermissionCard appears, approve, tool card completes. (If hermes never asks, exercise via opencode file-write prompt; if neither harness emits a permission request, record that honestly and cover the flow with the fake-node evidence.)
  4. Hub-owned semantics: close the tab mid-turn, reopen → replay catches up including turn output ("working while away").
  5. End session from the header → confirm → transcript keeps, "New session" starts fresh; no acp process remnant on the node.
- [ ] Update `acp-sessions-program` memory (slice 3 shipped, findings), ledger complete.

## Self-Review Notes

- Slice-2 carry-ins covered: end-session UX (T6/T7), `replay-done.lastSeq` distrust (T2 cursor rule, Global Constraints), error-copy pass (T3/T7 copy).
- `plan`/`available_commands`/`current_mode` session updates deliberately ignored in v1 (YAGNI — slice 4 revisits with multi-session); usage_update kept because it's one field and the header has a natural home for it later (stored, not yet rendered — T2 stores it, no task renders it; that is intentional).
- Optimistic prompt reconcile is by pending-flag replacement, not text matching — single-user session, prompts are serialized by the hub's 409-on-concurrent-turn, so the next `user-prompt` event always corresponds to the pending item.
- `svelte-streamdown` version pinned exact (`-E`) per repo convention; `renderHtml={false}` + link-prefix allowlist is the sanitization decision (no DOMPurify needed).
