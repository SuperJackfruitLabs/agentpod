# ACP Sessions — Design

**Date:** 2026-08-09 · **Status:** approved (brainstormed with Rakesh)

## Purpose

Drive every onboarded agent from the console through one protocol. AgentPod today observes agents (health/logs/files/terminal); this program makes them *conversable*: a world-class chat surface on each agent, harness-agnostic, built once against the Agent Client Protocol (ACP). It also closes the provisioned-runtime gap found in dogfooding: a provisioned OpenCode runtime arrives with nothing running and no way to start it.

## Decisions (from brainstorm)

1. **Client home:** console-native chat surface; hub exposes the machinery. A raw ACP-over-WS bridge for external clients (e.g. acp-ui) is deferred (slice "Doors").
2. **Session lifecycle:** **hub-owned**. The agent process keeps working when the browser tab closes; transcripts persist; the console reattaches with replay.
3. **Slice-1 harnesses:** OpenCode (provisioned runtime story end-to-end) + Hermes (native ACP on the real fleet, proves harness-agnosticism). Claude Code/Codex adapters later.
4. **Permissions:** per-session mode — `ask` (default; every request prompts in chat), `accept-edits` (file ops auto-approved, exec prompts), `full-auto` (all approved, logged). All decisions audited.
5. **Architecture:** **hub-terminated ACP** (Approach A). The hub is the protocol-level ACP client; the console speaks a thin session API. Browser-terminated ACP was rejected (sessions would die with the tab); day-one raw bridge rejected (surface without need).

## Verified facts (2026-08-09)

- `hermes acp` exists on the fleet ("Start Hermes Agent in ACP mode"; `--accept-hooks` for non-TTY).
- `opencode acp` is native in current opencode ([opencode.ai/docs/acp](https://opencode.ai/docs/acp/)); the runtime image pins `opencode-ai@0.5.5` which predates it → slice 1 bumps the pinned version.
- Official TS SDK: `@zed-industries/agent-client-protocol` (a.k.a. `@agentclientprotocol/sdk`), MIT — typed schema + `ClientSideConnection` over any duplex stream. The hub adopts it; nothing hand-rolls JSON-RPC.
- `svelte-streamdown` (MIT) — Svelte port of Vercel's Streamdown, built for streaming AI markdown (incomplete-block tolerance, shiki, hardened HTML). The console adopts it for Response rendering.
- AI Elements is React-only; we mirror its component taxonomy in Svelte on Crisp tokens, not its code.
- The node-agent needs **no** ACP library: it pipes stdio bytes, exactly like the Terminal.

## Architecture

```
Console (Svelte)
  ⇅ session WebSocket: replay (since-cursor) + live events; send prompt; answer permission; set mode
Hub
  • ACP client per session: official TS SDK ClientSideConnection over a broker stream
  • session service: Postgres transcripts, permission queue, mode enforcement, fan-out
  ⇅ broker stream: raw ACP JSON-RPC bytes (existing gateway rails)
node-agent (Go)
  • spawns the harness ACP process in the station workspace; pipes stdio; supervises
  ⇅ stdio
opencode acp · hermes acp · (later: claude-agent-acp, codex adapter)
```

Session states: `starting → idle ⇄ working → waiting (pending permission) → ended(reason)`.
`waiting` maps to the `starting` status token and surfaces in Needs attention.

## Components

### Contract (`packages/contract`)
- Verbs: `acp.open` (spawn; returns streamId), `acp.data` (bidirectional byte frames), `acp.close`.
- `"acp"` joins the station capabilities vocabulary.
- Zod schemas + tests, mirroring the terminal verb shapes.

### node-agent (Go)
- Descriptor interface gains `ACPCommand() (argv []string, ok bool)`:
  - OpenCode: `["opencode", "acp"]`, cwd = workspace.
  - Hermes: `["hermes", "acp", "--accept-hooks"]` with the profile's environment, cwd = profile workspace (exact profile wiring verified against the fleet during implementation).
- `acp.open` spawns via the same epoch-guarded stream plumbing as the terminal; process exit → close frame with reason; gateway disconnect kills the process (no zombies).
- Provisioned-runtime fixes (this slice):
  - `Dockerfile.opencode`: bump `opencode-ai` to a current pinned version with `acp` support.
  - opencode descriptor advertises `lifecycle` inside provisioned containers; start/stop manage a supervised harness process so Health's Start button works.
  - `TailLogs(follow=true)` with no log files **waits/watches** for them instead of returning (fixes the Logs-tab instant-close bug for every harness).

### Hub
- Tables: `acp_sessions` (id, station_id, user_id, mode, status, created_at, last_event_at, ended_reason) and `acp_events` (session_id, seq, type, payload jsonb, created_at) — append-only replayable transcript (turns, chunks, reasoning, tool calls, permission requests/answers, state changes).
- Session service: owns one `ClientSideConnection` per live session over a broker stream; translates ACP callbacks → stored events → fan-out to subscribed console sockets; enforces the permission mode (auto-answer or persist as pending); prompt turns recorded in the existing activity log.
- Console-facing WS: subscribe(sessionId, sinceSeq) → replay + live; `prompt`, `cancel`, `permission-answer`, `set-mode`.
- Restart semantics: on hub boot, live sessions are marked `ended("hub restarted")`; node-agents kill ACP processes when their gateway connection dies (same rule as terminals). Honest, no zombie agents.
- Node offline mid-session: session → `waiting` with an in-transcript notice; grace window for node reconnect + broker stream reattach, else `ended("node offline")`.

### Console
- **Chat tab** on the station page — first tab when the station has the `acp` capability.
- Adopted: `svelte-streamdown` (Response), official SDK types (event payloads). Component anatomy (AI Elements taxonomy, Crisp tokens):
  - **Conversation** — virtualized transcript (`content-visibility`, LogTail-style), auto-follow with scroll-away pause + jump-to-bottom, replay on reattach.
  - **Response** — streamdown streaming markdown; code via existing shiki theming.
  - **Reasoning** — collapsible thinking block when emitted.
  - **ToolCall card** — verb + target in mono, live `<Status>`, collapsible input/output, file edits rendered with the ConfigEditor diff view.
  - **PermissionCard** — inline approve/deny with ACP-provided options; answered cards show who/when; pending pulses the status dot.
  - **PromptInput** — auto-grow textarea, Enter sends / Shift+Enter newline, stop button (`session/cancel`); slash commands passed through.
  - **Session header** — mode selector (Ask / Accept edits / Full auto), session `<Status>`, working-while-away indicator.
- Quality bar: type roles, status tokens, reduced-motion, `aria-live` on turn/permission updates, keyboard-complete. Error copy in the "Couldn't X" grammar.

## Testing

- Contract: schema round-trip tests for the three verbs.
- node-agent: Go tests with a scripted fake-ACP stdio binary (handshake, streaming, crash, disconnect-kill), TestMain re-exec pattern per repo gotchas.
- Hub: integration tests with a scripted agent behind a fake broker — replay cursors, permission queue per mode, restart semantics.
- Console: component tests (replay render, streaming append, permission flow, mode switch); the scripted agent doubles as a Playwright dogfood scenario.
- Live verification against the real fleet (Hermes) and a provisioned runtime (OpenCode) before slices close — per repo rule.

## Slices (each lands mergeable + green → PR → CI → deploy)

1. **Rails:** contract verbs · node-agent ACP spawn/pipe · OpenCode + Hermes `ACPCommand` · image version bump · provisioned lifecycle + entrypoint supervision · TailLogs follow fix.
2. **Brain:** hub session service, Postgres persistence, permission queue, session WS.
3. **Face:** console Chat tab (full component set above).
4. **Breadth:** Claude Code + Codex adapters, multi-session per agent, session history UI. *(Later door: raw ACP-over-WS bridge for external clients.)*

## Out of scope (this program)

Multi-user shared sessions, programmatic/AI-SDK access to fleet agents, the acp-ui bridge, session branching/forking, cost/token accounting.
