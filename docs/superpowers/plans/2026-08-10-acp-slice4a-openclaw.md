# ACP Slice 4a — OpenClaw Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenClaw stations become conversable from the console Chat tab, over the rails slices 1–3 already built.

**Architecture:** OpenClaw speaks ACP natively (`openclaw acp`, since v2026.1.20, built on the same `@agentclientprotocol/sdk` 1.3.0 the hub uses), so there is no adapter to install and no protocol work. The whole slice is one node-agent change: teach the openclaw descriptor to implement `ACPCommander` and advertise the `acp` capability. The hub and console are harness-agnostic and need **zero** changes.

**Tech Stack:** Go (node-agent descriptor + config), no TS changes.

## Global Constraints

- **`openclaw acp` is a Gateway-backed bridge, not a self-contained runtime.** It connects to an OpenClaw Gateway over WebSocket and routes by session key `agent:<name>:<session>`. Without a reachable Gateway the bridge is useless. Verified invocation surface on the fleet's installed build (2026.3.28): `openclaw acp [--url <ws>] [--token-file <path>] [--session <key>] [--session-label <label>] [--require-existing] [--reset-session] [--no-prefix-cwd] [--provenance <mode>] [-v]`.
- **Never put a secret in argv.** `openclaw acp` accepts both `--token` and `--token-file`; we use **only** `--token-file` — argv is world-readable via `ps` on a shared host.
- Flags are all **optional on purpose**: with a locally-running Gateway and OpenClaw's own config, `openclaw acp` resolves `gateway.remote.url` itself, so a default install needs no node config at all. Only emit a flag when we have a value.
- The `acp` capability may be advertised **only** by descriptors implementing `ACPCommander` — the contract is documented at `apps/node-agent/internal/descriptor/descriptor.go:178`.
- `ACPCommand` errors surface to the user through the hub as `Couldn't start the agent process — <err>`. Write descriptor errors as a lowercase fragment that composes into that sentence.
- **Go test hygiene** (root `CLAUDE.md`): never leave unreaped children whose `comm` matches a pgrep target, and macOS SIGKILLs copied system binaries. This plan therefore makes the gateway-liveness probe **injectable** so no test ever spawns or pgreps a real process.
- Do not change `NewOpenClaw`'s existing signature in a way that breaks its callers (`apps/node-agent/cmd/agentpod-node/registry.go:11` and existing tests).
- Commit trailers on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01TbNjcG9KvVyeLFSZcXu8HB`

## File Structure

```
apps/node-agent/internal/descriptor/openclaw.go        + OpenClawConfig, NewOpenClawFrom, ACPCommand, "acp" cap, injectable gateway probe
apps/node-agent/internal/descriptor/acp_command_test.go  + openclaw ACPCommand tests + capability subtest
apps/node-agent/internal/config/config.go              + OpenClawGatewayURL / OpenClawTokenFile / OpenClawSessionLabel
apps/node-agent/cmd/agentpod-node/registry.go          pass the new config through
apps/node-agent/cmd/agentpod-node/run.go               (only if registry's signature change reaches it)
docs/OPERATING.md                                      OpenClaw ACP prerequisites + config keys
```

---

### Task 1: OpenClaw `ACPCommander` + config plumbing + docs

**Files:**
- Modify: `apps/node-agent/internal/descriptor/openclaw.go`
- Modify: `apps/node-agent/internal/config/config.go`
- Modify: `apps/node-agent/cmd/agentpod-node/registry.go` (and `run.go` if the signature change reaches it)
- Modify: `docs/OPERATING.md`
- Test: `apps/node-agent/internal/descriptor/acp_command_test.go`

**Interfaces:**
- Consumes: `ACPCommander` (`descriptor.go:178`): `ACPCommand(key string) (argv []string, dir string, env []string, err error)` — `argv[0]` is the binary, `dir` is cwd, `env` is *extra* `KEY=VALUE` appended to the inherited environment (may be nil). Existing openclaw helpers to reuse: `o.workspaceFor(key)` (`openclaw.go:134`, handles both the root key `openclaw` and `openclaw:<agent>`, and errors on anything else) and `openclawGatewayPID()` (`openclaw.go:300`).
- Produces (used by the gate and by later slices):
  ```go
  // OpenClawConfig carries everything the descriptor needs. Zero values are valid:
  // an empty GatewayURL/TokenFile means "let openclaw resolve it from its own config".
  type OpenClawConfig struct {
      Home         string // default: <user home>/.openclaw
      StartCmd     string // lifecycle Start (existing behaviour)
      GatewayURL   string // → --url
      TokenFile    string // → --token-file  (never --token)
      SessionLabel string // session component of agent:<name>:<label>; default "main"
  }
  func NewOpenClawFrom(cfg OpenClawConfig) Descriptor
  func NewOpenClaw(home string, startCmd ...string) Descriptor // unchanged wrapper over NewOpenClawFrom
  ```

**Session-key mapping** (the one genuinely new decision — mirrors how hermes maps its root key to "no `-p`"):
- root station key `openclaw` → session key `agent:main:<label>`
- `openclaw:<agent>` → `agent:<agent>:<label>`
- `<label>` is `cfg.SessionLabel`, defaulting to `"main"`.

- [ ] **Step 1: Write the failing tests** in `acp_command_test.go`. Follow the file's existing style (it already has `TestHermesACPCommand_*` and `assertAllStationsHaveACP`; there is a fixture helper pattern per harness). Build an openclaw fixture home with `<home>/agents/<name>` dirs — check whether `openclaw_test.go` already has such a helper and reuse it rather than writing a second one.

```go
// gatewayUp lets a test declare the gateway live without spawning a process
// (see Global Constraints: no pgrep targets in tests).
func TestOpenClawACPCommand_RootStation(t *testing.T) {
	home := testdataOpenClawHome(t) // reuse existing fixture helper if present
	d := NewOpenClawFrom(OpenClawConfig{Home: home})
	d.(*openclawDescriptor).gatewayUp = func() bool { return true }

	c, ok := d.(ACPCommander)
	if !ok {
		t.Fatal("openclaw descriptor must implement ACPCommander")
	}
	argv, dir, env, err := c.ACPCommand("openclaw")
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	want := []string{"openclaw", "acp", "--no-prefix-cwd", "--session", "agent:main:main"}
	if !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want %v", argv, want)
	}
	if dir == "" {
		t.Error("dir must be the station workspace, got empty")
	}
	if env != nil {
		t.Errorf("env = %v, want nil (inherit)", env)
	}
}

func TestOpenClawACPCommand_AgentStation(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClawFrom(OpenClawConfig{Home: home, SessionLabel: "console"})
	d.(*openclawDescriptor).gatewayUp = func() bool { return true }

	argv, dir, _, err := d.(ACPCommander).ACPCommand("openclaw:analyst")
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	if got := argv[len(argv)-1]; got != "agent:analyst:console" {
		t.Errorf("session key = %q, want agent:analyst:console", got)
	}
	if !strings.HasSuffix(dir, filepath.Join("agents", "analyst")) {
		t.Errorf("dir = %q, want the analyst agent workspace", dir)
	}
}

func TestOpenClawACPCommand_GatewayFlags(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClawFrom(OpenClawConfig{
		Home:       home,
		GatewayURL: "wss://gw.example:18789",
		TokenFile:  "/etc/agentpod/openclaw.token",
	})
	d.(*openclawDescriptor).gatewayUp = func() bool { return false } // a URL makes the local probe irrelevant

	argv, _, _, err := d.(ACPCommander).ACPCommand("openclaw")
	if err != nil {
		t.Fatalf("ACPCommand: %v", err)
	}
	joined := strings.Join(argv, " ")
	for _, want := range []string{"--url wss://gw.example:18789", "--token-file /etc/agentpod/openclaw.token"} {
		if !strings.Contains(joined, want) {
			t.Errorf("argv %q missing %q", joined, want)
		}
	}
	for _, arg := range argv {
		if arg == "--token" {
			t.Fatal("--token must never be used: argv is world-readable via ps")
		}
	}
}

func TestOpenClawACPCommand_NoGatewayNoURL(t *testing.T) {
	home := testdataOpenClawHome(t)
	d := NewOpenClawFrom(OpenClawConfig{Home: home})
	d.(*openclawDescriptor).gatewayUp = func() bool { return false }

	if _, _, _, err := d.(ACPCommander).ACPCommand("openclaw"); err == nil {
		t.Fatal("expected an error when no gateway is running and no URL is configured")
	} else if !strings.Contains(err.Error(), "gateway") {
		t.Errorf("error %q should name the gateway so the console message is actionable", err)
	}
}

func TestOpenClawACPCommand_BadKey(t *testing.T) {
	d := NewOpenClawFrom(OpenClawConfig{Home: testdataOpenClawHome(t)})
	d.(*openclawDescriptor).gatewayUp = func() bool { return true }

	if _, _, _, err := d.(ACPCommander).ACPCommand("hermes:main"); err == nil {
		t.Fatal("expected error for unrecognized key")
	}
}
```

Also add an openclaw subtest to the existing `TestCapabilitiesIncludeACP` (`acp_command_test.go:115`):

```go
	t.Run("openclaw", func(t *testing.T) {
		assertAllStationsHaveACP(t, NewOpenClaw(testdataOpenClawHome(t)))
	})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/node-agent && go test ./internal/descriptor/ -run 'OpenClaw' -v`
Expected: compile failure (`NewOpenClawFrom` / `OpenClawConfig` / field `gatewayUp` undefined), then assertion failures.

- [ ] **Step 3: Implement**

In `openclaw.go`: add the struct fields (`gatewayURL`, `tokenFile`, `sessionLabel string`, `gatewayUp func() bool`), `OpenClawConfig`, `NewOpenClawFrom` (defaulting `Home` exactly as the current `NewOpenClaw` does, `sessionLabel` to `"main"`, and `gatewayUp` to `func() bool { _, err := openclawGatewayPID(); return err == nil }`), and keep `NewOpenClaw` as a wrapper. Add `"acp"` to the caps slice at `openclaw.go:64`. Then:

```go
// ACPCommand implements ACPCommander. OpenClaw speaks ACP natively via
// `openclaw acp`, which is a bridge to the OpenClaw Gateway rather than a
// self-contained runtime: it dials the Gateway over WebSocket and addresses
// work by session key agent:<name>:<session>. Everything except --session is
// optional so a default local install (Gateway running, openclaw's own config)
// needs no node configuration at all.
func (o *openclawDescriptor) ACPCommand(key string) ([]string, string, []string, error) {
	workspace, err := o.workspaceFor(key)
	if err != nil {
		return nil, "", nil, err
	}

	// A configured URL points at a remote Gateway, so the local probe says
	// nothing; without one, a dead local Gateway means the bridge would start,
	// fail to dial, and leave the user waiting on the hub's handshake deadline.
	// Failing here turns that into an immediate, actionable message.
	if o.gatewayURL == "" && !o.gatewayUp() {
		return nil, "", nil, fmt.Errorf("openclaw: the OpenClaw gateway isn't running on this node — start it before opening a session")
	}

	agent := "main"
	if name := strings.TrimPrefix(key, "openclaw:"); name != key && name != "" {
		agent = name
	}
	label := o.sessionLabel
	if label == "" {
		label = "main"
	}

	// --no-prefix-cwd: the bridge otherwise prefixes every prompt with the
	// working directory, which is redundant here — the station IS its workspace
	// and we already set cmd.Dir — and it pollutes the transcript.
	argv := []string{"openclaw", "acp", "--no-prefix-cwd"}
	if o.gatewayURL != "" {
		argv = append(argv, "--url", o.gatewayURL)
	}
	if o.tokenFile != "" {
		// --token-file only, never --token: argv is world-readable via ps.
		argv = append(argv, "--token-file", o.tokenFile)
	}
	argv = append(argv, "--session", fmt.Sprintf("agent:%s:%s", agent, label))

	return argv, workspace, nil, nil
}
```

In `config.go` add, alongside `OpenClawStartCmd`:

```go
  // OpenClawGatewayURL / OpenClawTokenFile / OpenClawSessionLabel configure the
  // `openclaw acp` bridge. All optional: with a local Gateway, openclaw resolves
  // its own URL from config. The token is passed as a FILE PATH, never inline —
  // argv is world-readable.
  OpenClawGatewayURL   string `json:"openclawGatewayUrl,omitempty"`
  OpenClawTokenFile    string `json:"openclawTokenFile,omitempty"`
  OpenClawSessionLabel string `json:"openclawSessionLabel,omitempty"`
```

Then thread them through `buildRegistry` (`registry.go:8`) to `NewOpenClawFrom`. Keep `buildRegistry`'s change minimal and update its callers/tests; if the parameter list is growing unwieldy, pass a small struct rather than a fifth positional string.

- [ ] **Step 4: Run the tests**

Run: `cd apps/node-agent && go test -race ./...`
Expected: PASS, all packages.

- [ ] **Step 5: Document**

In `docs/OPERATING.md`, add a short "OpenClaw agent sessions (ACP)" subsection near the existing OpenClaw/lifecycle material: the Gateway prerequisite, that `openclaw acp` needs OpenClaw ≥ 2026.1.20, the three optional config keys with an example `config.json` fragment, the token-file-not-token rule, and the fact that a station will refuse to open a session with a clear message when no Gateway is running.

- [ ] **Step 6: Commit**

```bash
git add apps/node-agent docs/OPERATING.md
git commit -m "feat(node-agent): openclaw acp sessions"
```

---

### Task 2: Slice gate — suites, PR, CI, live verification (controller-run)

- [ ] `cd apps/node-agent && go test -race ./...`; plus contract, hub, and console suites green (they should be untouched — confirm, don't assume).
- [ ] Push; PR `feat: ACP slice 4a — OpenClaw sessions`; CI green; merge.
- [ ] Deploy the node-agent build to the OpenClaw-bearing node (molt-bot, `buddhimaan-root`): build `GOOS=linux GOARCH=amd64`, scp over `/usr/local/bin/agentpod-node`, `apn restart`.
- [ ] **Bring up an OpenClaw Gateway on that node.** As of 2026-08-10 there is none: no `openclaw-gateway` unit, no gateway process, no `gateway.token`, no `gateway` section in `~/.openclaw/clawdbot.json` — 19 agent workspaces sit idle. This is a state change on a live host: prefer the least invasive route (a user systemd unit or `openclaw gateway` detached), record exactly what was started and how to stop it, and confirm no other OpenClaw state is touched.
- [ ] Re-detect and adopt an OpenClaw station in the console; confirm it advertises `acp` (capabilities only refresh via re-adoption — `POST /api/nodes/:id/stations/adopt`).
- [ ] Live chat: open the Chat tab on that station, send a real prompt, confirm streamed output lands as transcript events, then end the session and confirm no `openclaw acp` process remains on the node.
- [ ] Confirm the honest-failure path: with the Gateway stopped, opening a session shows the "gateway isn't running" message promptly rather than hanging for the hub's 30s handshake deadline.
- [ ] Record in the PR: the transcript excerpt, and which OpenClaw ACP surfaces proved thin in practice (its documented gaps: `session/load` full replay only for bridge-created sessions, permission requests scoped to the active turn, tool calls without terminals or structured diffs, no per-session MCP servers, approximate usage data).
- [ ] Update the `acp-sessions-program` memory; ledger complete.

## Self-Review Notes

- No hub or console changes: the Chat tab keys off the `acp` capability alone, and the transcript fold ignores unknown `sessionUpdate` values, so OpenClaw's thinner tool-call payloads degrade rather than break.
- Multi-session is explicitly NOT in this slice (next slice): the node still keys one ACP process per station key, so one OpenClaw station means one bridge process. OpenClaw itself supports many concurrent sessions per process, which is worth exploiting when multi-session lands — it may let a station host N console sessions through a single bridge.
- `--require-existing` and `--reset-session` are deliberately unused: we want create-if-missing, and resetting would discard the agent's Gateway-side history, which is the opposite of what a console session should do.
- The root-station → `agent:main:<label>` mapping is the one assumption to confirm during live verification; the fleet does have an `openclaw:main` station, so if the root key proves ambiguous in practice, refusing it with a clear message is the better answer than guessing.
