# Pi Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Pi as the sixth harness — detected on enrolled machines, conversable via the Chat tab, and provisionable as a container image.

**Architecture:** A new Go descriptor (`pi.go`) discovers stations by enumerating `~/.pi/agent/sessions/*/` and reading each session file's header for the workspace path *verbatim*. Chat goes through the pinned `pi-acp` adapter, with the `acp` capability gated on that adapter resolving. Container images are refactored to a shared base plus thin per-harness layers, and Pi's layer needs no supervision loop because Pi has no daemon.

**Tech Stack:** Go 1.26 (node-agent), Bun + Hono + Drizzle (hub), Svelte 5 (console), Docker, zod 4 (contract).

**Spec:** `docs/superpowers/specs/2026-08-12-pi-harness-design.md` — read it first. Every design decision and its evidence lives there.

## Global Constraints

- Pi version pinned: `@earendil-works/pi-coding-agent@0.84.1`. Adapter pinned: `pi-acp@0.0.33`.
- Pi requires **Node ≥ 22.19**; the image uses `node:24-bookworm-slim`.
- `Harness()` returns exactly `"pi"` and **must** equal the `RuntimeHarness` enum value, or auto-adoption silently fails to match.
- Station key format: `pi:<first 8 hex chars of SHA256(workspacePath)>`.
- `lifecycle` is **never** advertised and `Lifecycle` is **not** implemented — Pi has no daemon.
- Every external path added to `creds.go` carries a dated observation comment. Paths are verified on a real machine, never taken from documentation.
- TDD: failing test first, every time. Never weaken a test to get green.
- Run the FULL command set after the LAST edit, not before it: node-agent `go test -race ./...`; hub `DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test`; console `pnpm check && pnpm test && pnpm build`.

---

### Task 1: Container base image refactor

Do this FIRST and alone. It touches the working OpenCode image, and Pi must not be what discovers a regression in it.

**Files:**
- Create: `apps/node-agent/deploy/Dockerfile.base`
- Modify: `apps/node-agent/deploy/Dockerfile`, `apps/node-agent/deploy/Dockerfile.opencode`
- Modify: `docs/DEPLOYMENT.md` (build commands, section 3)

**Interfaces:**
- Produces: an image tagged `agentpod-node:base` carrying the built `agentpod-node` binary at `/agentpod-node` and `ca-certificates`, `curl`, `git`, `procps`.

- [ ] **Step 1: Read the two existing Dockerfiles completely** before changing anything, and note which lines are harness-specific versus shared.

- [ ] **Step 2: Create `Dockerfile.base`** with everything shared: the Go build stage, the runtime base, `ca-certificates curl git procps`, and the binary at `/agentpod-node`. Do **not** set an `ENTRYPOINT` — layers set their own.

- [ ] **Step 3: Rewrite `Dockerfile` and `Dockerfile.opencode` as `FROM agentpod-node:base`**, keeping only their harness-specific lines. `Dockerfile.opencode` keeps bun, `opencode-ai@1.18.15`, the deliberate omission of `sqlite3`, and its existing entrypoint unchanged.

- [ ] **Step 4: Build all three images**

```bash
cd /Users/rakeshgangwar/Projects/agentpod
docker build -f apps/node-agent/deploy/Dockerfile.base     -t agentpod-node:base           apps/node-agent
docker build -f apps/node-agent/deploy/Dockerfile          -t agentpod-node:local          apps/node-agent
docker build -f apps/node-agent/deploy/Dockerfile.opencode -t agentpod-node-opencode:local apps/node-agent
```
Expected: all three succeed.

- [ ] **Step 5: Verify the OpenCode entrypoint is byte-identical** (the Cloudflare parity test depends on this file being untouched)

```bash
cd cloudflare/worker-v2 && npx vitest run test/entrypoint-parity.test.ts
```
Expected: PASS.

- [ ] **Step 6: Verify the rebuilt OpenCode image still enrols.** Provision an OpenCode runtime against the local hub, confirm the station is adopted, then destroy it. **This is the gate for the whole task** — if it fails, stop and fix before Task 2.

- [ ] **Step 7: Commit**

```bash
git add apps/node-agent/deploy docs/DEPLOYMENT.md
git commit -m "refactor(images): shared base image with per-harness layers"
```

---

### Task 2: Pi descriptor — Detect

**Files:**
- Create: `apps/node-agent/internal/descriptor/pi.go`, `apps/node-agent/internal/descriptor/pi_test.go`

**Interfaces:**
- Produces: `func NewPi(dataDir string) Descriptor` (empty `dataDir` → `$HOME/.pi/agent`, honouring `PI_CODING_AGENT_DIR`); `piProjectKey(path string) string`; type `piDescriptor` with `Harness() string` returning `"pi"`.

- [ ] **Step 1: Write the failing test.** Build a fixture mirroring the real layout observed on 2026-08-12, including the two cases that matter:

```go
// buildPiFixture creates <tmp>/sessions/<encoded>/<ts>_<uuid>.jsonl files whose
// first line carries the workspace path verbatim, plus a session dir with no
// jsonl at all (observed live: `pi --mode rpc` creates the dir without a session).
func buildPiFixture(t *testing.T) (dataDir string, wsHyphen string) {
	t.Helper()
	root := t.TempDir()
	dataDir = filepath.Join(root, "agent")

	// A real workspace whose name CONTAINS A HYPHEN. Decoding the directory
	// name would yield ".../idea/bank", which does not exist — the station
	// would vanish silently. This is the case that forces header parsing.
	wsHyphen = filepath.Join(root, "Projects", "idea-bank")
	if err := os.MkdirAll(wsHyphen, 0o755); err != nil { t.Fatal(err) }
	writePiSession(t, dataDir, "--"+strings.ReplaceAll(strings.TrimPrefix(wsHyphen, "/"), "/", "-")+"--", wsHyphen)

	// A session dir with NO jsonl — must be skipped, never guessed at.
	if err := os.MkdirAll(filepath.Join(dataDir, "sessions", "--private-tmp--"), 0o755); err != nil { t.Fatal(err) }

	// A session whose workspace no longer exists — must be filtered out.
	writePiSession(t, dataDir, "--gone--", filepath.Join(root, "deleted"))
	return dataDir, wsHyphen
}

func writePiSession(t *testing.T, dataDir, encoded, cwd string) {
	t.Helper()
	dir := filepath.Join(dataDir, "sessions", encoded)
	if err := os.MkdirAll(dir, 0o755); err != nil { t.Fatal(err) }
	header := fmt.Sprintf(`{"type":"session","version":3,"id":"x","timestamp":"2026-08-12T08:10:23.796Z","cwd":%q}`, cwd)
	if err := os.WriteFile(filepath.Join(dir, "2026-08-12T08-10-23-796Z_uuid.jsonl"), []byte(header+"\n"), 0o644); err != nil { t.Fatal(err) }
}

func TestPiDetectReadsWorkspaceFromSessionHeader(t *testing.T) {
	dataDir, wsHyphen := buildPiFixture(t)
	stations, err := NewPi(dataDir).Detect()
	if err != nil { t.Fatal(err) }
	if len(stations) != 1 {
		t.Fatalf("want 1 station, got %d: %+v", len(stations), stations)
	}
	s := stations[0]
	if s.WorkspacePath == nil || *s.WorkspacePath != wsHyphen {
		t.Errorf("workspace = %v, want %s (a hyphenated path must survive)", s.WorkspacePath, wsHyphen)
	}
	if s.Harness != "pi" { t.Errorf("harness = %q, want pi", s.Harness) }
	if s.Key != piProjectKey(wsHyphen) { t.Errorf("key = %q", s.Key) }
}

func TestPiDetectMissingDataDirReturnsEmpty(t *testing.T) {
	stations, err := NewPi(filepath.Join(t.TempDir(), "nope")).Detect()
	if err != nil { t.Fatalf("missing data dir must not error: %v", err) }
	if len(stations) != 0 { t.Errorf("want empty, got %+v", stations) }
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/node-agent && go test ./internal/descriptor/ -run TestPiDetect -v`
Expected: FAIL — `undefined: NewPi`.

- [ ] **Step 3: Implement `pi.go`** — `NewPi`, `piProjectKey` (SHA256 prefix, mirroring `openCodeProjectKey`), and `Detect`: stat `<dataDir>/sessions`, return `[]Station{}` when absent; for each subdirectory read the first line of the first `*.jsonl`, `json.Unmarshal` it, take `cwd`; skip dirs with no readable jsonl; skip paths that no longer exist; dedupe via `filepath.EvalSymlinks`. Capabilities: `[]string{"health","logs","fs.read","fs.write","terminal","cleanup"}` wrapped in `AppendChangesetCap(caps, &wsCopy)`. **Do not** add `acp` yet (Task 4) and **never** add `lifecycle`.

- [ ] **Step 4: Run the test again**

Run: `cd apps/node-agent && go test ./internal/descriptor/ -run TestPiDetect -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/internal/descriptor/pi.go apps/node-agent/internal/descriptor/pi_test.go
git commit -m "feat(node-agent): Pi descriptor detection via session headers"
```

---

### Task 3: Pi descriptor — Health, fs, logs, cleanup

**Files:**
- Modify: `apps/node-agent/internal/descriptor/pi.go`, `apps/node-agent/internal/descriptor/pi_test.go`

**Interfaces:**
- Consumes: `NewPi`, `piProjectKey` from Task 2.
- Produces: `Health`, `ListDir`, `ReadFile`, `TailLogs`, `CleanPlan`, `CleanApply` on `piDescriptor` — satisfying the full `Descriptor` interface plus `Cleaner`.

- [ ] **Step 1: Write the failing tests** — health returns without error and `Running=false` when no Pi process exists (that is correct, not a fault); `ListDir` rejects `..` escape; `ReadFile` truncates at `maxBytes`; `TailLogs` with no log file returns without error in one-shot mode.

```go
func TestPiHealthNoProcessIsNotAnError(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	h, err := NewPi(dataDir).Health(piProjectKey(ws))
	if err != nil { t.Fatalf("health must not error when Pi is not running: %v", err) }
	if h.Running { t.Error("Running should be false with no pi process") }
}

func TestPiListDirRejectsEscape(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	if _, err := NewPi(dataDir).ListDir(piProjectKey(ws), "../.."); err == nil {
		t.Error("expected .. escape to be rejected")
	}
}

func TestPiTailLogsWithNoLogFileDoesNotError(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	err := NewPi(dataDir).TailLogs(context.Background(), piProjectKey(ws), false, func([]byte) error { return nil })
	if err != nil { t.Fatalf("absent pi-debug.log must not error: %v", err) }
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/node-agent && go test ./internal/descriptor/ -run TestPi -v`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement.** `ListDir`/`ReadFile` via `safeJoin`, copied in shape from `opencode.go:484-559`. `CleanPlan`/`CleanApply` via `cleanPlanCommon(projPath, []string{".pi/cache"})` — verify that directory is genuinely cache on a real machine before widening the list. `TailLogs` reads `<dataDir>/pi-debug.log` using the shared `emitLastNLines` / `waitForLogFiles` helpers from `tail.go`. `Health`: `DiskBytes` from `diskUsage(projPath)`, `LastActivity` from `newestMtime` over the station's session dir, `Running` from `pgrep -f` matching the **resolved Pi entry path plus `--mode rpc`** — never the bare string `pi`. On `exec.ExitError` code 1 return `false` with no note (no match is not an error).

- [ ] **Step 4: Run tests**

Run: `cd apps/node-agent && go test -race ./internal/descriptor/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/internal/descriptor/
git commit -m "feat(node-agent): Pi health, fs, logs and cleanup"
```

---

### Task 4: ACP via the pinned pi-acp adapter

**Files:**
- Modify: `apps/node-agent/internal/descriptor/pi.go`
- Create: `apps/node-agent/internal/descriptor/pi_acp_test.go`
- Modify: `apps/node-agent/internal/descriptor/acp_command_test.go` (add the sixth subtest)

**Interfaces:**
- Consumes: `NewPi` from Task 2.
- Produces: `ACPCommand(key string) (argv []string, dir string, env []string, err error)` on `piDescriptor`.

- [ ] **Step 1: Read `claudecode.go` and `codex.go` ACPCommand plus `binary.go` completely.** They already solve adapter resolution with a version floor; follow their pattern rather than inventing one.

- [ ] **Step 2: Write the failing test** — `acp` is advertised only when the adapter resolves, and `ACPCommand` returns the adapter argv with the workspace as cwd:

```go
func TestPiACPCapabilityGatedOnAdapter(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	// No adapter on PATH → no acp capability, and a clear error rather than a
	// Chat tab that fails when clicked.
	t.Setenv("PATH", t.TempDir())
	stations, err := NewPi(dataDir).Detect()
	if err != nil { t.Fatal(err) }
	for _, c := range stations[0].Capabilities {
		if c == "acp" { t.Fatal("acp must not be advertised without the pi-acp adapter") }
	}
	if _, _, _, err := NewPi(dataDir).(ACPCommander).ACPCommand(piProjectKey(ws)); err == nil {
		t.Error("ACPCommand should error when the adapter is absent")
	}
}

func TestPiACPCommandUsesAdapterAndWorkspaceDir(t *testing.T) {
	dataDir, ws := buildPiFixture(t)
	bin := t.TempDir()
	stub := filepath.Join(bin, "pi-acp")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil { t.Fatal(err) }
	t.Setenv("PATH", bin)

	argv, dir, _, err := NewPi(dataDir).(ACPCommander).ACPCommand(piProjectKey(ws))
	if err != nil { t.Fatal(err) }
	if len(argv) == 0 || filepath.Base(argv[0]) != "pi-acp" { t.Errorf("argv = %v, want pi-acp first", argv) }
	if dir != ws { t.Errorf("dir = %q, want %q", dir, ws) }
}
```

- [ ] **Step 3: Run and confirm failure**

Run: `cd apps/node-agent && go test ./internal/descriptor/ -run TestPiACP -v`
Expected: FAIL — `ACPCommand` undefined.

- [ ] **Step 4: Implement.** Resolve `pi-acp` on `PATH` (honouring a `PI_ACP_PATH` override, mirroring `CODEX_PATH`). Add `"acp"` to the capability slice in `Detect` **only** when resolution succeeds. `ACPCommand` returns `[]string{resolvedPath}`, `dir` = workspace, `env` = nil, and a descriptive error when unresolved.

- [ ] **Step 5: Add the sixth conformance subtest** in `acp_command_test.go` — but note it asserts every fixture station carries `acp`, so the Pi subtest must place a `pi-acp` stub on `PATH` first.

- [ ] **Step 6: Run the full descriptor suite**

Run: `cd apps/node-agent && go test -race ./internal/descriptor/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/node-agent/internal/descriptor/
git commit -m "feat(node-agent): Pi ACP via the pinned pi-acp adapter, capability-gated"
```

---

### Task 5: Registry wiring and posture

**Files:**
- Modify: `apps/node-agent/cmd/agentpod-node/registry.go:28` (after the OpenCode registration)
- Modify: `apps/node-agent/internal/posture/creds.go:29`
- Modify: `apps/node-agent/internal/posture/posture_test.go`

**Interfaces:**
- Consumes: `descriptor.NewPi` from Task 2.

- [ ] **Step 1: Register the descriptor** — add `reg.Register(descriptor.NewPi(""))` to `buildRegistry`.

- [ ] **Step 2: Write the failing posture test** asserting the Pi entry lists exactly the files observed on a real machine, and that the two files Pi's docs mention but that do not exist are absent:

```go
func TestPiCredentialPathsMatchRealLayout(t *testing.T) {
	got := CredentialPaths["pi"]
	want := []string{".pi/agent/auth.json", ".pi/agent/models-store.json", ".pi/agent/models.json"}
	if !reflect.DeepEqual(got, want) { t.Errorf("got %v, want %v", got, want) }
}

func TestPiCredentialPathsDropFilesThatNeverExisted(t *testing.T) {
	// trust.json is documented by Pi but is created on demand and was absent on
	// the machine observed 2026-08-12. Naming files that do not exist is how the
	// scanner once graded a machine "A" without opening anything.
	for _, p := range CredentialPaths["pi"] {
		if strings.Contains(p, "trust.json") { t.Errorf("trust.json must not be listed: %s", p) }
	}
}
```

- [ ] **Step 3: Run and confirm failure**

Run: `cd apps/node-agent && go test ./internal/posture/ -run TestPi -v`
Expected: FAIL — no `"pi"` key.

- [ ] **Step 4: Add the `creds.go` entry** with a dated comment recording that the layout was verified on 2026-08-12, that `auth.json` and `models-store.json` were observed `0600`, and that `models.json` is conditional (it can hold literal API keys but does not exist until a custom provider is defined). Add nothing to `StationCredentialLayouts` — Pi is not composite. Add nothing to `HarnessProcessNames` — Pi is stdio-only.

- [ ] **Step 5: Run the whole node-agent suite**

Run: `cd apps/node-agent && go test -race ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/node-agent
git commit -m "feat(node-agent): register Pi and add its dated posture entry"
```

---

### Task 6: Pi container image

**Files:**
- Create: `apps/node-agent/deploy/Dockerfile.pi`
- Modify: `docs/DEPLOYMENT.md`

**Interfaces:**
- Consumes: `agentpod-node:base` from Task 1.

- [ ] **Step 1: Create `Dockerfile.pi`**

```dockerfile
# Pi harness image. Unlike the OpenCode image this needs NO supervision loop:
# Pi has no daemon, it is invoked per command, so the generic entrypoint
# (enrol, then run) is correct and no entrypoint-parity pair arises.
FROM agentpod-node:base

# Pi requires Node >= 22.19.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# --ignore-scripts matches Pi's own installer. Both pins are deliberate:
# a floating tag would make two builds of the same image behave differently.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.1 \
 && npm install -g --ignore-scripts pi-acp@0.0.33

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

- [ ] **Step 2: Build it**

```bash
docker build -f apps/node-agent/deploy/Dockerfile.pi -t agentpod-node-pi:local apps/node-agent
```
Expected: success.

- [ ] **Step 3: Verify the harness and adapter are present and the versions are the pinned ones**

```bash
docker run --rm --entrypoint sh agentpod-node-pi:local -c 'pi --version; pi-acp --version || true; node -v'
```
Expected: `0.84.1`, and Node ≥ 22.19.

- [ ] **Step 4: Verify detection inside the image.** Create a Pi session directory with a header, then run `agentpod-node detect` and confirm a `pi:` station appears. **This is the gate** — the descriptor must work in the image, not only against the Go fixture.

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/deploy/Dockerfile.pi docs/DEPLOYMENT.md
git commit -m "feat(images): Pi harness image"
```

---

### Task 7: Provisioning — contract, hub, console

**Files:**
- Modify: `packages/contract/src/runtime.ts:17`, `packages/contract/src/runtime.test.ts`
- Modify: `apps/hub/src/services/runtimes.ts:44-50`
- Modify: `apps/console/src/lib/components/fleet/NewRuntimeDialog.svelte:39-42`
- Modify: `apps/console/src/routes/nodes/[id]/+page.svelte:177`

- [ ] **Step 1: Write the failing contract test**

```ts
it("accepts pi as a provisionable harness", () => {
  expect(ProvisionRequest.parse({ provider: "docker", name: "x", resourceTier: "small", harness: "pi" }).harness).toBe("pi");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/contract && bun test`
Expected: FAIL — `"pi"` not in the enum.

- [ ] **Step 3: Add `"pi"`** to `RuntimeHarness`, add the `imageForHarness` branch returning `process.env.NODE_AGENT_PI_IMAGE ?? "agentpod-node-pi:local"`, add `{ value: "pi", label: "Pi" }` to the dialog, and add Pi to the empty-state copy at `+page.svelte:177` (it enumerates the harnesses by name).

- [ ] **Step 4: Run all three suites**

```bash
cd packages/contract && bun test
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
cd apps/console && pnpm check && pnpm test && pnpm build
```
Expected: all pass. Run these **after** the last edit.

- [ ] **Step 5: Commit**

```bash
git add packages/contract apps/hub apps/console
git commit -m "feat: Pi as a provisionable harness"
```

---

### Task 8: Live verification

Not optional. Everything above is scaffolding for this.

- [ ] **Step 1: Detection on a real machine.** On a host with Pi installed and at least two projects, run `apn detect` and confirm one `pi:` station per project — including any workspace whose directory name contains a hyphen.

- [ ] **Step 2: Verify Linux process naming.** The spec records `comm` as `node` on macOS and flags Linux as unverified. Run Pi on a Linux node, check what `pgrep -f` matches, and correct the health pattern if it differs. **Do not skip this** — the health pattern is the single most bug-prone line in any descriptor here.

- [ ] **Step 3: Chat end to end.** Open the Chat tab on a Pi station and send a prompt. Confirm a reply, and confirm `station_audit` records `acp.prompt` with result `ok`.

- [ ] **Step 4: Provision a Pi runtime**, confirm the station is auto-adopted (this proves `Harness()` matches the enum value), then destroy it.

- [ ] **Step 5: Record what was verified, on which machines, with dates** in the PR body. Anything not verified is stated as not verified.

---

## Self-review notes

- **Spec coverage:** base image (T1), Detect (T2), health/fs/logs/cleanup (T3), ACP (T4), registry + posture (T5), image (T6), provisioning (T7), live verification (T8). The spec's "out of scope" items — a Pi Cloudflare worker, a multi-harness image, `pi-server` — have no tasks by design.
- **Deliberately deferred within this plan:** a Pi Cloudflare deployment. Task 6 produces the image; wiring a second worker is separate work.
- **Known risk:** Task 1 touches the working OpenCode image. Its Step 6 gate exists precisely so a regression there is caught before any Pi code is written.
