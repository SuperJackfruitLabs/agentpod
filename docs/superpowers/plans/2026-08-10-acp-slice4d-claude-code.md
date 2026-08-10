# ACP Slice 4d — Claude Code Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code stations become conversable from the console Chat tab, and two blemishes 4c's live verification exposed get cleaned up.

**Architecture:** Claude Code has **no native ACP** (verified against the CLI: no `acp` subcommand). The official-lineage adapter is `@agentclientprotocol/claude-agent-acp` — a Node program that speaks ACP over stdio and drives Claude Code underneath. So unlike OpenClaw (native) and unlike a Gateway bridge, this needs an *external program* present on the node. The whole slice is therefore: a node-agent descriptor change that resolves and runs that adapter, plus the small hub/console cleanups.

**Tech Stack:** Go (node-agent), Drizzle migration (backfill), Svelte (one copy fix).

## Global Constraints

- **Verified adapter facts (2026-08-10 — do not re-derive, and do NOT use the `@zed-industries/*` names, which are deprecated):**
  - Package `@agentclientprotocol/claude-agent-acp`, version **0.66.0**, bin `claude-agent-acp`, `engines: node >= 22`.
  - Canonical invocation: `npx -y @agentclientprotocol/claude-agent-acp`.
  - It speaks JSON-RPC on stdout and deliberately redirects `console.log/warn/debug` to **stderr**, so stdout stays clean framing. It exits on stdin EOF / SIGTERM / SIGINT.
  - Auth: **no API key needed when the host already has Claude Code credentials** (a live `initialize` returned `authMethods: []`). Relevant env: `CLAUDE_CODE_EXECUTABLE`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_MODEL`.
  - It advertises `loadSession: true`, supports `session/request_permission`, `session/cancel`, `agent_thought_chunk`, tool-call updates, and multiple concurrent sessions per process.
  - **Version-skew trap:** it resolves a Claude Code binary shipped as an optional dependency of its own SDK — NOT the node's installed `claude` — unless `CLAUDE_CODE_EXECUTABLE` points at one. Set it when we can find the node's `claude`, so the chat session and what the Health tab reports are the same install.
- **Prefer a pre-installed adapter over `npx`-at-spawn.** `npx -y` resolves ~100 packages on first use: slow first session and it needs network on every node. Resolution order mirrors the OpenClaw work: explicit config override → a resolved `claude-agent-acp` binary on PATH/well-known paths → `npx -y <pkg>@<pinned version>` as the last resort. Failing that, an actionable error naming the config key.
- Node >= 22 is a hard requirement of the adapter. Detect it and fail with an actionable message rather than letting the adapter die with a syntax error.
- The `acp` capability may only be advertised by a descriptor implementing `ACPCommander` (contract at `apps/node-agent/internal/descriptor/descriptor.go:178`).
- Descriptor errors compose into the console's `Couldn't start the agent process — <err>`: lowercase fragments.
- Go test hygiene (root `CLAUDE.md`): never leave unreaped children whose `comm` matches a pgrep target; macOS SIGKILLs copied system binaries. Keep every host-touching probe behind an injectable seam, as `openclaw.go` now does — no test may depend on node/npx/claude being installed.
- Commit trailers on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01TbNjcG9KvVyeLFSZcXu8HB`

## File Structure

```
apps/node-agent/internal/descriptor/claudecode.go        ACPCommand, "acp" capability, adapter+runtime resolution
apps/node-agent/internal/descriptor/claudecode_acp_test.go   NEW: resolution + argv tests
apps/node-agent/internal/descriptor/acp_command_test.go  retarget the negative case, add the capability subtest
apps/node-agent/internal/config/config.go                claudeCodeAcpBinary, claudeCodeBinary, nodeBinary
apps/node-agent/cmd/agentpod-node/registry.go            thread the config through
docs/OPERATING.md                                        Claude Code ACP prerequisites
apps/hub/src/db/drizzle-migrations/0027_*.sql            last_seq backfill
apps/console/src/lib/components/stations/chat/…          one untitled-fallback copy fix
```

---

### Task 1: Claude Code `ACPCommander`

**Files:**
- Modify: `apps/node-agent/internal/descriptor/claudecode.go`, `internal/config/config.go`, `cmd/agentpod-node/registry.go`, `docs/OPERATING.md`
- Modify: `internal/descriptor/acp_command_test.go` — `TestHandlerACPCommand_UnsupportedHarness` currently asserts **claude-code** returns "acp not supported"; retarget it at **openclaw**… no: openclaw now supports ACP too. Retarget at **codex** (still unsupported until 4e), and add a `claude-code` subtest to `TestCapabilitiesIncludeACP`.
- Test: `internal/descriptor/claudecode_acp_test.go`

**Interfaces:**
- Reuse the existing shape: `ACPCommand(key string) (argv []string, dir string, env []string, err error)`. The claude-code descriptor already resolves a station's project path (`projectPathForKey`, used by Health/ListDir/ReadFile) — that is `dir`.
- New config keys (all optional), threaded through `buildRegistry(config.Config)`:
  ```go
  ClaudeCodeAcpBinary string `json:"claudeCodeAcpBinary,omitempty"` // a claude-agent-acp executable
  ClaudeCodeBinary    string `json:"claudeCodeBinary,omitempty"`    // the claude CLI, for CLAUDE_CODE_EXECUTABLE
  NodeBinary          string `json:"nodeBinary,omitempty"`          // node/npx runtime, when not on PATH
  ```
- Resolution, behind injectable seams:
  1. `ClaudeCodeAcpBinary` if set → argv `[that]`.
  2. else a `claude-agent-acp` on PATH or well-known paths (reuse/generalise the openclaw well-known list: `$HOME/.local/share/pnpm`, `$HOME/.local/bin`, `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`) → argv `[that]`.
  3. else `npx` (resolved the same way) → argv `[npx, -y, @agentclientprotocol/claude-agent-acp@0.66.0]` — pin the version; an unpinned `npx -y` silently upgrades the fleet mid-flight.
  4. else error: `claude-code: couldn't find claude-agent-acp or npx on this node — set claudeCodeAcpBinary in the node config`.
- Node runtime check: resolve `node` (config override → PATH → well-known) and read `node --version`; if < 22, error `claude-code: node 22+ is required by claude-agent-acp (found <v>)`. Behind a seam so tests inject the version string.
- `env`: set `CLAUDE_CODE_EXECUTABLE=<resolved claude>` when a claude CLI is found (config override → PATH → well-known), so the ACP session and the Health tab agree on one install. Set nothing else. Never put a secret in argv or env here — Claude Code's own credentials are already on the host.
- Advertise `"acp"` in the caps slice (`claudecode.go:86`).

- [ ] **Step 1 (RED):** tests in `claudecode_acp_test.go`, all seams injected: config override wins verbatim; a resolved `claude-agent-acp` beats npx; npx fallback produces the pinned `@0.66.0` argv; nothing resolvable → the actionable error naming `claudeCodeAcpBinary`; node 21 → the version error, node 22 and 24 → fine; `CLAUDE_CODE_EXECUTABLE` present when a claude is found and absent when not; `dir` is the station's project path; a bad key errors before anything is resolved. Plus the two edits in `acp_command_test.go`.
- [ ] **Step 2:** `cd apps/node-agent && go test ./internal/descriptor/ -run 'ClaudeCode|Capabilities|Unsupported' -v` → FAIL.
- [ ] **Step 3:** implement. Factor the shared "resolve a binary: override → PATH → well-known" helper out of `openclaw.go` rather than copying it, keeping openclaw's behaviour identical (its tests must stay green untouched).
- [ ] **Step 4:** `go test -race ./... && go vet ./...` green.
- [ ] **Step 5:** Document in `docs/OPERATING.md`: the adapter, the three config keys, the Node 22 requirement, that credentials come from the host's Claude Code install, and the `CLAUDE_CODE_EXECUTABLE` skew note. Commit `feat(node-agent): claude code acp sessions`.

---

### Task 2: Cleanups from 4c's live verification

**Files:**
- Create: `apps/hub/src/db/drizzle-migrations/0027_*.sql` (via drizzle-kit or a hand-written data migration — see below)
- Modify: one console chat component (the untitled-session fallback)
- Test: hub migration behaviour if practical; console copy test

**Two independent fixes, both found live:**
1. **`last_seq` backfill.** Sessions created before 4c have `last_seq = 0`, so history shows "no events" for conversations that plainly have events. Add a data migration: `UPDATE acp_sessions SET last_seq = (SELECT COALESCE(MAX(seq), 0) FROM acp_events e WHERE e.session_id = acp_sessions.id) WHERE last_seq = 0;`. This is a data-only migration — drizzle-kit generates schema diffs, so it may need to be hand-added as `0027_*.sql` **with** its journal entry written the way drizzle expects; check how the repo's existing migrations are registered and follow it exactly rather than inventing a format.
2. **Inconsistent untitled fallback.** The switcher renders "Session 9" while the history dialog renders "Untitled session" for the same row. Pick ONE (the 4c plan specified "Session N") and use it in both surfaces, via the existing shared label helper.

- [ ] **Step 1 (RED):** a console test asserting both surfaces render the same fallback for an untitled row.
- [ ] **Step 2:** FAIL. **Step 3:** implement both. **Step 4:** hub suite + `pnpm check && pnpm test` green. Verify the migration applies cleanly against the test DB and is idempotent (running it twice changes nothing further).
- [ ] **Step 5:** Commit `fix: backfill last_seq and unify the untitled-session label`.

---

### Task 3: Slice gate — suites, PR, CI, live verification (controller-run)

- [ ] Four suites green.
- [ ] Push; PR `feat: ACP slice 4d — Claude Code sessions`; CI green; merge.
- [ ] Release + deploy: cut the next `v0.1.x` tag (the fleet self-updates with `apn update`, and **verify the release is complete** — 4 binaries + `install.sh` + service unit + SHA256SUMS covering all, since an incomplete release bricks self-update). Deploy the hub (`bun x pnpm@10 install --frozen-lockfile --filter @agentpod/hub...`, restart) and the console (build with `PUBLIC_HUB_URL`, then `wrangler pages deploy`).
- [ ] **Find a node with claude-code stations first** — check each node's `/detected` for `claude-code:*` keys; the Mac (`Rakeshs-MacBook-Pro.local`) is the likely host. Re-adopt after upgrading, since capabilities only refresh on re-adoption.
- [ ] Live: open Chat on a claude-code station, send a real prompt, confirm streamed output and a permission request if one arises (Claude Code's adapter *does* implement `session/request_permission`, so `ask` mode should finally exercise the PermissionCard that neither OpenCode nor Hermes triggered). End the session; confirm no adapter process remains.
- [ ] Verify the backfill: a pre-4c session now shows a real event count in history.
- [ ] Update the `acp-sessions-program` memory; ledger complete.

## Self-Review Notes

- The version pin on the npx fallback is deliberate: `npx -y <pkg>` with no version would let a fleet-wide adapter upgrade land silently between two sessions, which is exactly the kind of drift the v0.1.14/15 releases were cut to end.
- `CLAUDE_CODE_EXECUTABLE` is the one env var worth setting: without it the adapter talks to a *different* Claude Code build than the station's Health tab reports, which would make a version-dependent bug impossible to reason about.
- Claude Code's adapter is the first one that reliably asks for permission, so this slice is also the first honest live test of the PermissionCard shipped in slice 3.
- Multiple ACP sessions per adapter process are supported, but this slice keeps one process per session (slice 4b's instance keying) — uniform across harnesses, and a crash can't take out a sibling conversation.
