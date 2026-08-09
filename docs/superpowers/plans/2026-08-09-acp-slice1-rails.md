# ACP Slice 1 — Rails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The node-side rails for ACP sessions: contract verbs, node-agent spawn/pipe of harness ACP processes (OpenCode + Hermes), the provisioned-runtime lifecycle fix, and the TailLogs follow bug fix.

**Architecture:** Mirror the terminal subsystem exactly: contract verbs (`acp.open/attach/close` + reused `input` frames), a non-PTY `internal/acp` session manager (plain stdio pipes — ACP is JSON-RPC over stdio; a PTY would corrupt it with echo/CRLF), a gateway `acpHandler` wrapping the dispatch chain like `terminalHandler` does, and a per-descriptor `ACPCommand`. Provisioned opencode containers additionally supervise `opencode serve` as the station's long-running process so Health/lifecycle mean something.

**Tech Stack:** Zod (contract), Go (node-agent), Docker (runtime image). No ACP library anywhere in this slice — the node-agent pipes opaque bytes.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-09-acp-sessions-design.md`. Slice 1 only — no hub session service, no console UI.
- Commands: contract tests `cd packages/contract && bun test`; node-agent `cd apps/node-agent && go test -race ./...`.
- Go tests must never leave unreaped children named like pgrep targets; use the existing TestMain re-exec pattern for named process stubs (see repo root CLAUDE.md gotcha).
- ACP verbs mirror terminal verb naming/shape exactly (`acp.open`/`acp.attach`/`acp.close`).
- ACP sessions use plain pipes, never a PTY.
- Conventional commits + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Work on branch `ui-revamp` in this worktree; never touch `develop` or the main checkout.

## File Map

| File | Responsibility |
|---|---|
| `packages/contract/src/station.ts` | add `"acp"` to `Capability` enum |
| `packages/contract/src/protocol.ts` (+ `protocol.test.ts`) | `acp.*` verb param/result schemas |
| `apps/node-agent/internal/acp/session.go`, `manager.go` (+ tests) | non-PTY process session + registry |
| `apps/node-agent/internal/descriptor/descriptor.go` | `ACPCommander` optional interface |
| `apps/node-agent/internal/descriptor/opencode.go` (+ test) | opencode ACPCommand + `acp` capability + supervised-serve lifecycle |
| `apps/node-agent/internal/descriptor/hermes.go` (+ test) | hermes ACPCommand + `acp` capability |
| `apps/node-agent/internal/descriptor/handler.go` | expose ACPCommand resolution to gateway |
| `apps/node-agent/internal/gateway/acp.go` (+ `dispatch_acp_test.go`) | `acpHandler` verb routing + frame I/O |
| `apps/node-agent/internal/descriptor/tail.go` (+ `tail_test.go`) | follow-mode waits for log files |
| `apps/node-agent/deploy/Dockerfile.opencode`, `node-opencode-entrypoint.sh` | opencode version bump + supervised serve |

---

### Task 1: Contract — `acp` capability + verbs

**Files:**
- Modify: `packages/contract/src/station.ts:2` (Capability enum)
- Modify: `packages/contract/src/protocol.ts` (VERB param/result maps — mirror the `term.*` entries at lines ~31-33 and ~51-53)
- Test: `packages/contract/src/protocol.test.ts` (append)

**Interfaces:**
- Produces: `Capability` includes `"acp"`; verb schemas:
  - `"acp.open"` params `{ key: string }` → result `{ sessionId: string }`
  - `"acp.attach"` params `{ sessionId: string }` → stream (no result entry; same convention as `term.attach`)
  - `"acp.close"` params `{ sessionId: string }` → result `{ ok: boolean }`
- ACP input rides the existing `InputMsg` frame (`sessionId` + base64 `data`) — no new frame type. ACP has no resize.

- [ ] **Step 1: Write the failing tests** — in `protocol.test.ts`, following the existing term.* test style:

```ts
test("acp.open params/result schemas round-trip", () => {
  expect(VERB_PARAMS["acp.open"].parse({ key: "opencode:c52ddf65" })).toEqual({ key: "opencode:c52ddf65" });
  expect(VERB_RESULTS["acp.open"].parse({ sessionId: "acp_1" })).toEqual({ sessionId: "acp_1" });
});

test("acp.attach takes a sessionId; acp.close returns ok", () => {
  expect(VERB_PARAMS["acp.attach"].parse({ sessionId: "acp_1" })).toEqual({ sessionId: "acp_1" });
  expect(VERB_PARAMS["acp.close"].parse({ sessionId: "acp_1" })).toEqual({ sessionId: "acp_1" });
  expect(VERB_RESULTS["acp.close"].parse({ ok: true })).toEqual({ ok: true });
});

test("station capabilities accept acp", () => {
  expect(Capability.parse("acp")).toBe("acp");
});
```

(Import `Capability` from `./station` alongside the existing imports.)

- [ ] **Step 2:** `cd packages/contract && bun test` — expect the three new tests FAIL (unknown key / invalid enum).
- [ ] **Step 3:** Implement — add `"acp"` to the `Capability` z.enum; add to `protocol.ts`:

```ts
// in VERB_PARAMS
"acp.open":   z.object({ key: z.string() }),
"acp.attach": z.object({ sessionId: z.string() }),
"acp.close":  z.object({ sessionId: z.string() }),
// in VERB_RESULTS
"acp.open":  z.object({ sessionId: z.string() }),
"acp.close": z.object({ ok: z.boolean() }),
// acp.attach streams; no entry needed (same as term.attach).
```

- [ ] **Step 4:** `bun test` → all pass.
- [ ] **Step 5:** Commit `feat(contract): acp capability + acp.open/attach/close verb schemas`.

---

### Task 2: node-agent — `internal/acp` session + manager

**Files:**
- Create: `apps/node-agent/internal/acp/session.go`, `apps/node-agent/internal/acp/manager.go`
- Test: `apps/node-agent/internal/acp/session_test.go`

**Interfaces (Produces — Task 4 consumes these exact signatures):**

```go
package acp

type Session struct { /* opaque */ }
func (s *Session) ID() string
func (s *Session) Write(p []byte) error                 // → child stdin
func (s *Session) Subscribe(fn func(chunk []byte)) (unsub func())
// OnExit registers a callback invoked exactly once when the child exits;
// reason is "exit" for a clean exit, otherwise the error string.
func (s *Session) OnExit(fn func(reason string))
func (s *Session) Close() error                          // SIGTERM → 3s grace → SIGKILL, idempotent

type Manager struct { /* opaque */ }
func NewManager() *Manager
// Open spawns argv[0] with argv[1:] in dir with env appended to os.Environ().
// stdout is streamed to subscribers in chunks; stderr is discarded to a
// bounded ring (last 4 KiB) exposed via s.StderrTail() for exit reasons.
func (m *Manager) Open(key string, argv []string, dir string, env []string) (*Session, error)
func (m *Manager) Get(id string) (*Session, bool)
func (m *Manager) Close(id string) error
func (m *Manager) Shutdown()                             // closes every session
```

Implementation notes (mirror `internal/terminal/manager.go` structure, but **no PTY**): `exec.Command`, `cmd.Dir = dir`, `cmd.Env = append(os.Environ(), env...)`, `StdinPipe`/`StdoutPipe`/`StderrPipe`. A goroutine reads stdout in 32 KiB chunks and fans out to subscribers under a mutex (same subscriber pattern as terminal.Session). A second goroutine drains stderr into the 4 KiB ring. `cmd.Wait()` goroutine fires OnExit callbacks with `"exit"` on success else `err.Error()+": "+stderrTail`. IDs: `"acp_" + <random hex 8>`.

- [ ] **Step 1: Write the failing tests** — use `/bin/cat` as the child (echoes stdin to stdout; exits on stdin close; no pgrep-name hazard):

```go
func TestSession_EchoRoundTrip(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	s, err := m.Open("k", []string{"/bin/cat"}, t.TempDir(), nil)
	if err != nil { t.Fatal(err) }
	got := make(chan []byte, 4)
	unsub := s.Subscribe(func(c []byte) { got <- append([]byte(nil), c...) })
	defer unsub()
	if err := s.Write([]byte("{\"jsonrpc\":\"2.0\"}\n")); err != nil { t.Fatal(err) }
	select {
	case c := <-got:
		if !strings.Contains(string(c), "jsonrpc") { t.Fatalf("chunk = %q", c) }
	case <-time.After(3 * time.Second):
		t.Fatal("no echo received")
	}
}

func TestSession_ExitFiresOnceWithReason(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	s, _ := m.Open("k", []string{"/bin/sh", "-c", "echo err >&2; exit 3"}, t.TempDir(), nil)
	reasons := make(chan string, 2)
	s.OnExit(func(r string) { reasons <- r })
	select {
	case r := <-reasons:
		if !strings.Contains(r, "exit status 3") || !strings.Contains(r, "err") {
			t.Fatalf("reason = %q", r)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no exit callback")
	}
	select { case r := <-reasons: t.Fatalf("second callback: %q", r); case <-time.After(200 * time.Millisecond): }
}

func TestManager_CloseKillsProcess(t *testing.T) {
	m := NewManager()
	s, _ := m.Open("k", []string{"/bin/cat"}, t.TempDir(), nil)
	done := make(chan string, 1)
	s.OnExit(func(r string) { done <- r })
	if err := m.Close(s.ID()); err != nil { t.Fatal(err) }
	select { case <-done: case <-time.After(5 * time.Second): t.Fatal("process not reaped") }
	if _, ok := m.Get(s.ID()); ok { t.Fatal("session still registered after Close") }
}
```

- [ ] **Step 2:** `cd apps/node-agent && go test -race ./internal/acp/` → FAIL (package missing).
- [ ] **Step 3:** Implement session.go + manager.go per the interface block.
- [ ] **Step 4:** `go test -race ./internal/acp/` → PASS; `go test -race ./...` stays green.
- [ ] **Step 5:** Commit `feat(node-agent): acp session manager — non-PTY stdio piping`.

---

### Task 3: Descriptors — `ACPCommander` for OpenCode + Hermes, `acp` capability

**Files:**
- Modify: `apps/node-agent/internal/descriptor/descriptor.go` (add optional interface after `Descriptor`)
- Modify: `apps/node-agent/internal/descriptor/opencode.go` (implement; add `"acp"` to caps at line ~112)
- Modify: `apps/node-agent/internal/descriptor/hermes.go` (implement; add `"acp"` to its caps list)
- Modify: `apps/node-agent/internal/descriptor/handler.go` (resolution helper)
- Test: `apps/node-agent/internal/descriptor/acp_command_test.go`

**Interfaces (Produces):**

```go
// ACPCommander is implemented by descriptors whose harness can serve an ACP
// session. argv is the full command line; dir is the working directory; env
// is extra environment (may be nil).
type ACPCommander interface {
	ACPCommand(key string) (argv []string, dir string, env []string, err error)
}
// handler.go resolution used by the gateway (mirrors LifecycleFunc wiring):
func (h *Handler) ACPCommand(key string) (argv []string, dir string, env []string, err error)
```

- OpenCode: `argv = ["opencode", "acp"]`, `dir` = the station's workspace path (same resolution `term.open` uses via the workspace resolver — reuse the descriptor's existing workspace lookup for the key), `env = nil`.
- Hermes: `argv = ["hermes", "-p", <profile>, "acp", "--accept-hooks"]`, `dir` = the profile's workspace directory, `env = nil`. The profile is derived from the station key exactly the way `hermes.go` already parses keys for Health/lifecycle (read `hermes.go` first and reuse its existing key→profile helper; do not invent a second parser).
- Capability: each implementing descriptor appends `"acp"` to its capabilities list. Handler exposes resolution with a clear error for descriptors that don't implement the interface (`"acp not supported for harness X"`).

- [ ] **Step 1: Write failing tests** (table-driven; no processes spawned — pure command construction):

```go
func TestOpenCodeACPCommand(t *testing.T) {
	d := newTestOpenCodeDescriptor(t) // reuse the fixture style of opencode_test.go
	argv, dir, _, err := d.ACPCommand(testStationKey)
	if err != nil { t.Fatal(err) }
	if !reflect.DeepEqual(argv, []string{"opencode", "acp"}) { t.Fatalf("argv = %v", argv) }
	if dir == "" { t.Fatal("dir must be the station workspace") }
}

func TestHermesACPCommand_UsesProfileFlag(t *testing.T) {
	d := newTestHermesDescriptor(t) // reuse hermes_test.go fixture style
	argv, _, _, err := d.ACPCommand(testHermesKey)
	if err != nil { t.Fatal(err) }
	want := []string{"hermes", "-p", testHermesProfile, "acp", "--accept-hooks"}
	if !reflect.DeepEqual(argv, want) { t.Fatalf("argv = %v want %v", argv, want) }
}

func TestCapabilitiesIncludeACP(t *testing.T) { /* assert "acp" present in both descriptors' Detect() station capabilities */ }

func TestHandlerACPCommand_UnsupportedHarness(t *testing.T) { /* claude-code descriptor → error containing "acp not supported" */ }
```

(Adapt fixture names to what `opencode_test.go` / `hermes_test.go` actually provide — read them first; the plan's names are placeholders for those exact existing fixtures, and the implementer must use the real ones.)

- [ ] **Step 2:** `go test -race ./internal/descriptor/` → new tests FAIL.
- [ ] **Step 3:** Implement per interface block.
- [ ] **Step 4:** `go test -race ./...` → PASS.
- [ ] **Step 5:** Commit `feat(node-agent): ACPCommand for opencode + hermes, acp capability`.

---

### Task 4: Gateway — `acpHandler` verb routing + frames

**Files:**
- Create: `apps/node-agent/internal/gateway/acp.go`
- Modify: the dispatch construction where `terminalHandler` is wired (grep `terminalHandler{` / `newTerminalHandler` in `apps/node-agent/internal/gateway/` and wire `acpHandler` identically, including Shutdown on gateway disconnect)
- Test: `apps/node-agent/internal/gateway/dispatch_acp_test.go`

**Interfaces:**
- Consumes: `acp.Manager` (Task 2), `Handler.ACPCommand` (Task 3) injected as `type ACPCommandFunc func(key string) (argv []string, dir string, env []string, err error)` — mirroring `LifecycleFunc`.
- Behavior (mirror `terminal.go`'s `terminalHandler` shape):
  - `acp.open {key}` → resolve ACPCommandFunc → `mgr.Open` → `{sessionId}`; register OnExit → emits a final stream frame `{"event":"exit","reason":<reason>}` (base64 in StreamMsg data, same envelope the terminal uses) to any attached subscriber, then cleans up.
  - `acp.attach {sessionId}` → subscribe; stdout chunks → StreamMsg frames (base64), same stream-envelope helper the terminal attach uses.
  - `acp.close {sessionId}` → `mgr.Close` → `{ok:true}`.
  - Inbound `InputMsg` frames: if `sessionId` belongs to the acp manager, decode base64 → `session.Write`; otherwise pass through to the inner handler (terminal), preserving the existing chain.
  - Gateway disconnect → `mgr.Shutdown()` alongside the terminal manager's.

- [ ] **Step 1: Write failing dispatch tests** — copy the structure of `dispatch_terminal_test.go` (fake connection, scripted verbs), child = `/bin/cat`:
  - open → attach → send InputMsg with base64 `{"jsonrpc":"2.0","id":1}` → expect a StreamMsg whose decoded data contains `jsonrpc` (cat echo).
  - open → kill child externally (send `acp.close`) → expect exit stream frame with `"event":"exit"`.
  - InputMsg for an unknown sessionId still reaches the terminal handler (chain preserved) — assert via a stub inner handler.
- [ ] **Step 2:** `go test -race ./internal/gateway/` → FAIL.
- [ ] **Step 3:** Implement `acp.go`; wire into dispatch construction + disconnect shutdown.
- [ ] **Step 4:** `go test -race ./...` → PASS.
- [ ] **Step 5:** Commit `feat(node-agent): acp gateway verbs — open/attach/close + input frames`.

---

### Task 5: TailLogs follow-mode waits for log files

**Files:**
- Modify: `apps/node-agent/internal/descriptor/tail.go` (the shared tail helper used by `opencode.go` TailLogs at ~line 373)
- Test: `apps/node-agent/internal/descriptor/tail_test.go` (append)

Behavior: today, follow-mode with zero matching log files returns immediately (hub then closes the SSE instantly — the Logs-tab bug found dogfooding 2026-08-09). New behavior: when `follow == true` and the glob matches nothing, poll the glob every 1s until ctx is cancelled or a file appears, then tail it as normal. `follow == false` keeps returning immediately.

- [ ] **Step 1: Write failing tests:**

```go
func TestTailFollow_WaitsForFirstLogFile(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	got := make(chan []byte, 8)
	go func() {
		// adapt call to tail.go's actual exported/internal helper signature
		_ = tailGlob(ctx, filepath.Join(dir, "*.log"), true, func(b []byte) error { got <- append([]byte(nil), b...); return nil })
	}()
	time.Sleep(300 * time.Millisecond) // helper is now waiting, not returned
	os.WriteFile(filepath.Join(dir, "a.log"), []byte("hello\n"), 0o644)
	select {
	case b := <-got:
		if !strings.Contains(string(b), "hello") { t.Fatalf("chunk = %q", b) }
	case <-ctx.Done():
		t.Fatal("no output after log file appeared — follow returned early or never polled")
	}
}

func TestTailNoFollow_EmptyDirReturnsImmediately(t *testing.T) {
	dir := t.TempDir()
	start := time.Now()
	_ = tailGlob(context.Background(), filepath.Join(dir, "*.log"), false, func([]byte) error { return nil })
	if time.Since(start) > time.Second { t.Fatal("no-follow should return immediately") }
}
```

(Adapt `tailGlob` to tail.go's real helper name/signature — read the file first; if the wait logic fits better at the `opencode.go` call site, put it there and test through the descriptor instead.)

- [ ] **Step 2:** `go test -race ./internal/descriptor/ -run TestTail` → first test FAILS (returns early).
- [ ] **Step 3:** Implement the 1s poll loop.
- [ ] **Step 4:** `go test -race ./...` → PASS.
- [ ] **Step 5:** Commit `fix(node-agent): log follow waits for log files instead of closing the stream`.

---

### Task 6: Provisioned opencode — image bump + supervised serve + lifecycle

**Files:**
- Modify: `apps/node-agent/deploy/Dockerfile.opencode` (line `RUN bun add -g opencode-ai@0.5.5`)
- Modify: `apps/node-agent/deploy/node-opencode-entrypoint.sh`
- Modify: `apps/node-agent/internal/descriptor/opencode.go` (lifecycle, gated)
- Test: `apps/node-agent/internal/descriptor/opencode_test.go` (append)

Requirements:
1. **Version bump:** replace `opencode-ai@0.5.5` with the newest published version (implementer runs `bun pm view opencode-ai version` / `npm view opencode-ai version` and pins that exact version). The chosen version MUST list `acp` in `opencode --help`; record the version in the Dockerfile comment.
2. **Entrypoint supervision:** after `enroll`, before the exec, start a supervised serve loop so the station has a living process:

```sh
# Supervised opencode server: the station's long-running process. Restarts on
# crash with 2s backoff; killed cleanly when the container stops.
(
  while :; do
    opencode serve >>/var/log/opencode-serve.log 2>&1
    echo "[entrypoint] opencode serve exited ($?), restarting in 2s" >>/var/log/opencode-serve.log
    sleep 2
  done
) &
export AGENTPOD_OPENCODE_SUPERVISED=1
```

   (Keep `cd /workspace` for the serve invocation — `cd /workspace && opencode serve` inside the subshell — so the server roots at the workspace.)
3. **Descriptor lifecycle, gated:** when env `AGENTPOD_OPENCODE_SUPERVISED=1`, the opencode descriptor implements the same Stop/Start interface the lifecycle dispatcher uses (see `lifecycle_test.go`'s `testLifecycleImpl` for the exact method set): `Stop` = terminate the `opencode serve` process (find via pgrep pattern `opencode.*serve`, TERM → grace → KILL using the existing helpers at `descriptor.go:120-138`); `Start` = re-spawn `opencode serve` detached in `/workspace` appending to the same log. Add `"lifecycle"` to opencode capabilities only when the env var is set. Without the env var (real hosts), behavior is unchanged.
4. **Health note:** with serve supervised, the existing `pgrep -f opencode` health check turns true on a fresh runtime — no health-code change needed.

- [ ] **Step 1: Write failing descriptor tests** (gate logic only — no real opencode binary): with `t.Setenv("AGENTPOD_OPENCODE_SUPERVISED", "1")` capabilities include `"lifecycle"`; without it they don't. For Stop/Start process handling use a stub script named to match the pgrep pattern via the repo's TestMain re-exec pattern (see `hermes_lifecycle_systemd_test.go` for the established approach) — or, if that pattern doesn't transfer cleanly, unit-test the pgrep-pattern/spawn-command construction and leave process behavior to live verification in Task 7.
- [ ] **Step 2:** `go test -race ./internal/descriptor/ -run TestOpenCode` → FAIL.
- [ ] **Step 3:** Implement descriptor gating + entrypoint + Dockerfile bump.
- [ ] **Step 4:** `go test -race ./...` → PASS. Also `docker build -f apps/node-agent/deploy/Dockerfile.opencode apps/node-agent -t agentpod-node-opencode:test` locally if Docker available; else defer build to Task 7.
- [ ] **Step 5:** Commit `feat(node-agent): provisioned opencode runs supervised serve with lifecycle control`.

---

### Task 7: Slice gate — full suites + live verification (controller-run)

- [ ] `cd packages/contract && bun test` → green.
- [ ] `cd apps/node-agent && go test -race ./...` → green.
- [ ] Push `ui-revamp`; open PR titled `feat: ACP slice 1 — rails (contract verbs, node-agent acp piping, runtime lifecycle, log-follow fix)`; wait for all four CI checks.
- [ ] Live verification (hub box `root@178.105.68.68`, per docs/DEPLOYMENT.md step 3): rebuild `agentpod-node-opencode:local` from the merged main, provision a fresh runtime from the console, then verify: Health shows **running** with a Start/Stop that works; Logs tab connects and stays connected (no instant-close); `docker exec` confirms `opencode serve` supervised; destroy the runtime and confirm it disappears from the list. Record results in the PR before merge.
- [ ] Merge on green + verified; deploy hub is NOT needed (no hub changes in this slice); node-agent release/tag is deferred until slice 2 needs fleet-wide binaries — the provisioned image embeds the new binary at build time.

## Self-Review Notes

- Spec coverage: contract verbs (T1), spawn/pipe (T2+T4), ACPCommand opencode+hermes (T3), capability advertising (T3), TailLogs fix (T5), image bump + entrypoint + lifecycle + Start button (T6), live verification (T7). Hub/session/console items are explicitly out of slice.
- Fixture names in T3 and helper names in T5 are explicitly marked as "use the real existing ones" — implementers must read the neighbouring test files first.
- Frame reuse (InputMsg) keeps the contract surface minimal; resize intentionally absent for ACP.
