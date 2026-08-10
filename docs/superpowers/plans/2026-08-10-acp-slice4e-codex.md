# ACP Slice 4e — Codex Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex projects appear as stations and become conversable from the console Chat tab.

**Architecture:** Codex is the last and least-finished harness. Its descriptor currently detects **nothing** — `Detect()` returns an empty slice and its comments assume a station-declaration API that does not exist — so unlike every other slice this one starts by making the harness visible at all. Then it gets ACP through the `@agentclientprotocol/codex-acp` adapter (Codex has no native ACP; the adapter wraps `codex app-server`), reusing the binary/runtime resolution the OpenClaw and Claude Code slices built.

**Tech Stack:** Go (node-agent) only. The hub and console are harness-agnostic and need no changes.

## Global Constraints

- **Verified facts (2026-08-10 — do not re-derive; the `@zed-industries/codex-acp` name in `docs/archive` is DEPRECATED):**
  - Adapter package `@agentclientprotocol/codex-acp`, version **1.1.14**, bin `codex-acp`, invoked `npx -y @agentclientprotocol/codex-acp`. Verify the exact version against the registry before pinning (the controller confirmed 0.66.0 for the Claude Code adapter this way; do the same here and report what you find).
  - It bundles its own Codex build; `CODEX_PATH` points it at a different Codex binary. Set it to the node's own `codex` when one resolves, for the same reason `CLAUDE_CODE_EXECUTABLE` exists in slice 4d: otherwise the chat session and the station's Health tab describe different installs.
  - Auth: ChatGPT login (browser) **or** `CODEX_API_KEY` / `OPENAI_API_KEY` (`CODEX_API_KEY` wins). **`NO_BROWSER=1` matters for a fleet** — it stops the adapter trying to open a browser on a headless node.
  - It advertises `loadSession: true` and session capabilities resume/list/close/delete/additionalDirectories (no `fork`), `agent_thought_chunk`, permission requests, plan and token-usage events.
  - Local ground truth on the Mac (the only host with Codex today): `codex-cli 0.36.0` at `/opt/homebrew/bin/codex`; `~/.codex/config.toml` contains `[projects."<absolute path>"]` tables with `trust_level`; `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` holds 12 session files.
- **Detection source: `~/.codex/config.toml`'s `[projects."<path>"]` table keys.** That is authoritative, cheap and stable. Do NOT parse session rollout JSONL for paths in this slice — it's a fallback at best, and the config gives us the same answer without a format dependency.
- Station keys follow the established scheme for path-derived harnesses: `codex:<first 8 hex of sha256(absolute project path)>`, exactly as `claudecode.go` and `opencode.go` do. Filter out paths that no longer exist, as claude-code does.
- The `acp` capability may only be advertised by a descriptor implementing `ACPCommander` (`descriptor.go:178`), and only advertise the other capabilities the descriptor can actually serve.
- Descriptor errors compose into `Couldn't start the agent process — <err>`: lowercase fragments naming the config key that fixes them.
- Reuse the shared `binaryLocator` and the Node-runtime gate from slice 4d rather than copying them; whatever 4d settled about `nodeBinary` governing the spawn applies here unchanged.
- Go test hygiene (root `CLAUDE.md`): no test may depend on codex/node/npx being installed; every host-touching probe stays behind an injectable seam; never leave unreaped children whose `comm` matches a pgrep target; macOS SIGKILLs copied system binaries.
- Commit trailers on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01TbNjcG9KvVyeLFSZcXu8HB`

## File Structure

```
apps/node-agent/internal/descriptor/codex.go                 Detect from config.toml, real Health/fs, ACPCommand
apps/node-agent/internal/descriptor/codex_test.go            NEW: detection + capability tests
apps/node-agent/internal/descriptor/codex_acp_test.go        NEW: adapter resolution + argv/env tests
apps/node-agent/internal/descriptor/acp_command_test.go      retarget the negative case again; add the codex capability subtest
apps/node-agent/internal/config/config.go                    codexAcpBinary, codexBinary
apps/node-agent/cmd/agentpod-node/registry.go                thread the config through
docs/OPERATING.md                                            Codex ACP prerequisites + auth on headless nodes
```

---

### Task 1: Make Codex stations exist

**Files:**
- Modify: `apps/node-agent/internal/descriptor/codex.go`
- Test: `apps/node-agent/internal/descriptor/codex_test.go` (new)

**Interfaces produced (consumed by Task 2):**
- `Detect()` returns one leaf station per existing `[projects."<path>"]` entry in `<home>/.codex/config.toml`, with `key: "codex:<8 hex>"`, `workspacePath` the absolute project path, `displayName` the path's base name, `kind: "leaf"`, `parentKey: nil`.
- `projectPathForKey(key)` mirroring `claudecode.go`'s helper, so every other method can resolve a station's directory.
- Capabilities: `health, logs, fs.read, fs.write, terminal, cleanup` — the same set `claude-code` advertises. **`acp` is added in Task 2, not here** (the contract ties it to `ACPCommander`).

Implementation notes:
- Parse the TOML by hand or with whatever TOML library is already in `go.mod`; check first — do NOT add a dependency for this if a simple scan of `[projects."..."]` lines suffices. Handle quoted paths containing spaces, and ignore every other table.
- If `~/.codex` or the config is missing, return an empty slice (nil-safe), exactly as the other descriptors do for a missing home.
- Replace the current placeholder behaviour: `Health` should follow `claudecode.go`'s shape (disk usage of the project, plus a best-effort "is a codex process working in this directory" check), and `ListDir`/`ReadFile` must serve the project path instead of returning errors. `TailLogs` already walks `~/.codex/sessions/` — keep it, but make it station-scoped if that's cheap; if not, leave it and say so.

- [ ] **Step 1 (RED):** `codex_test.go` with a fixture `~/.codex` — a `config.toml` containing three `[projects."…"]` entries (one with a space in the path, one that does not exist on disk) plus unrelated tables and top-level keys. Assert: two stations detected (the missing path filtered), keys are `codex:` + 8 hex and stable across calls, `workspacePath`/`displayName` correct, the unrelated tables ignored, capabilities exactly the expected set with **no `acp` yet**, a missing `~/.codex` yields an empty slice, and `ListDir`/`ReadFile` now serve files under the project path.
- [ ] **Step 2:** `cd apps/node-agent && go test ./internal/descriptor/ -run Codex -v` → FAIL.
- [ ] **Step 3:** implement. **Step 4:** `go test -race ./... && go vet ./...` green.
- [ ] **Step 5:** Commit `feat(node-agent): detect codex projects as stations`.

---

### Task 2: Codex `ACPCommander`

**Files:**
- Modify: `apps/node-agent/internal/descriptor/codex.go`, `internal/config/config.go`, `cmd/agentpod-node/registry.go`, `internal/descriptor/acp_command_test.go`, `docs/OPERATING.md`
- Test: `apps/node-agent/internal/descriptor/codex_acp_test.go` (new)

**Interfaces:**
- New optional config keys threaded through `buildRegistry(config.Config)`: `CodexAcpBinary` (`codexAcpBinary`) and `CodexBinary` (`codexBinary`).
- Resolution, via the shared `binaryLocator`: `codexAcpBinary` override → a `codex-acp` on PATH/well-known paths → `npx -y @agentclientprotocol/codex-acp@<pinned>` → else `codex: couldn't find codex-acp or npx on this node — set codexAcpBinary in the node config`.
- Node-runtime gate: reuse slice 4d's helper and whatever it concluded about which node actually runs the adapter.
- `env`: `NO_BROWSER=1` always (a fleet node must never try to open a browser), plus `CODEX_PATH=<resolved codex>` when the node's own codex resolves. **Do NOT put `CODEX_API_KEY`/`OPENAI_API_KEY` in argv or env from config** — that would place a secret in a process listing; if a node needs key auth, it belongs in the node-agent service's own environment, and OPERATING.md should say exactly that.
- `dir` is the station's project path. Add `"acp"` to the caps slice. Retarget `TestHandlerACPCommand_UnsupportedHarness` once more — after this slice every registered descriptor supports ACP, so either point it at a synthetic descriptor that doesn't implement `ACPCommander` or assert the handler's error path directly; do not delete the test.

- [ ] **Step 1 (RED):** `codex_acp_test.go`, all seams injected: override wins verbatim; a resolved `codex-acp` beats npx; the npx fallback carries the pinned version and `-y`; nothing resolvable → the actionable error naming `codexAcpBinary`; `NO_BROWSER=1` always present; `CODEX_PATH` present when a codex resolves and absent when not; no `*_API_KEY` ever appears in argv or env; `dir` is the project path; a bad key errors before any host probe. Plus the `acp_command_test.go` edits and a `codex` subtest in `TestCapabilitiesIncludeACP`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `go test -race ./... && go vet ./...` green.
- [ ] **Step 5:** Document in `docs/OPERATING.md`: the adapter and its pin, the two config keys, `NO_BROWSER=1`, that ChatGPT-login auth needs a one-time interactive `codex login` on the node (or an API key in the service environment, never in node config), and the `CODEX_PATH` skew note. Commit `feat(node-agent): codex acp sessions`.

---

### Task 3: Slice gate — suites, PR, CI, live verification (controller-run)

- [ ] Four suites green (contract; hub with the `:5434` override; node-agent `-race` + `vet`; console check+test+build) — the last three should be untouched by this slice; confirm rather than assume.
- [ ] Push; PR `feat: ACP slice 4e — Codex sessions`; CI green; merge.
- [ ] Release: cut the next `v0.1.x` tag and **verify completeness** (4 binaries + `install.sh` + service unit + SHA256SUMS covering every asset — an incomplete release bricks fleet self-update). Then `apn update` the Mac.
- [ ] Live verification runs on **the Mac** — it is the only host with Codex (`codex-cli 0.36.0`, `~/.codex/config.toml` with several trusted projects; no other node has a `~/.codex`). Confirm codex stations now appear in `/detected`, adopt one (capabilities only refresh on adoption), and check its Health/Files tabs work rather than erroring as they did before this slice.
- [ ] Live chat: open Chat on a codex station and send a real prompt. If auth is unresolved the adapter will say so — surface whatever it reports rather than guessing; a `codex login` on the Mac is acceptable setup, but note it in the PR as an operator step.
- [ ] End the session and confirm no `codex-acp` or `codex app-server` process remains.
- [ ] Update the `acp-sessions-program` memory (the ACP program is complete at this point — record the final harness matrix); ledger complete.

## Self-Review Notes

- Detection from `config.toml` rather than session files is the load-bearing choice: it is the only source that says "this is a project the user works in" rather than "a conversation happened here once", and it needs no JSONL format dependency.
- This slice deliberately fixes Codex's degraded `Health`/`ListDir`/`ReadFile` alongside detection. Shipping detection alone would create stations whose other tabs error — visible breakage that would read as a regression even though it predates the slice.
- No hub or console work: the Chat tab keys off the `acp` capability, and the transcript fold ignores unknown `sessionUpdate` values, so Codex's plan/token-usage events degrade rather than break.
- After this slice every harness in the registry speaks ACP, which retires the "unsupported harness" test's original subject — hence the note to re-point it at a synthetic descriptor rather than delete the coverage.
