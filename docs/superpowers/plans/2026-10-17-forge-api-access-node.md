# Forge API Access — Node Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A node accepts sealed forge credentials from the hub, installs them into a separate-user stk on the station, keeps stk's policy in step, wires the station's harness through stk's proxy, and wipes everything on revoke, with an honest isolation report.

**Architecture:** A thin `stkclient` wraps the `stk` CLI (JSON in/out) behind an interface. A gateway handler implements the `forge.api.*` verbs on it. The node advertises `forge.api` only when a usable stk exists. Harness wiring injects stk's proxy environment into ACP spawns and into systemd-started harnesses, with a bypass check per harness before a grant may report `verified`.

**Tech Stack:** Go (`apps/node-agent`), stdlib `os/exec`, existing gateway/descriptor packages. stk `>= 0.0.1` with slice 3 (supertoolkit PR #20): `stk install|env|verify|reload|revoke --local|handover open|doctor --json`.

**Spec:** `docs/superpowers/specs/2026-10-17-forge-api-access-design.md` (Node, Station topology, Verification). Companion hub plan: `docs/superpowers/plans/2026-10-17-forge-api-access-hub.md` (contract verbs are defined there; do Task 1 of that plan first).

## Global Constraints

- The node never logs, returns or writes to a frame, error, config or env file any token, private key, proxy key or passphrase. The sealed blob is passed to `stk handover open` on stdin and nowhere else.
- All stk invocations use `exec.Command` with an argument vector (no shell), a timeout, and a minimal environment; stdout/stderr are size-capped and never echoed into errors.
- The handler acknowledges only what stk confirmed (`stored: true`, verify result). A missing stk, an old stk (no `--json`), or a failed command is an error ack, never a silent success.
- Isolation is reported as stk's `doctor --json` says it, never inflated; `same-user` is allowed but labelled, and write presets in `same-user` need the hub's recorded acknowledgement (hub enforces; node refuses a deliver frame whose `isolation` requirement it cannot meet when the frame says `requireSeparateUser`).
- A station's grant file/entries are keyed by `grantId` and `stationId`; reassignment must leave no previous occupant's entry, credential, service, or environment behind.
- Go tests: stdlib only, `go test -race ./...`; process stubs use the TestMain re-exec pattern (see CLAUDE.md gotchas); never leave unreaped children.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; check PR state before pushing.

## Review Focus

1. No secret in any error, log line, ack or test output, including on every stk failure mode (non-zero exit, timeout, garbage JSON, oversized output).
2. `forge.api.deliver` is idempotent: replays of the same frame do not duplicate the service entry or reload twice with different results; a replay after a successful store returns `stored: true`.
3. Revoke leaves no residue: service entry, stored credential, proxy env, harness wiring, and cached state are all gone; revoke of an unknown grant is success (idempotent); a reconnect reconcile (hub resends revoke) is harmless.
4. Reassignment: a station whose occupant changed receives revoke before any deliver for the new occupant can succeed, and the harness environment no longer carries the previous grant's placeholders.
5. Capability advertisement: absent when stk is missing, too old, or not runnable by the node's user; present and truthful otherwise; the hub sees an error ack rather than a timeout for a verb the node cannot serve.
6. Harness wiring honesty: for each supported harness the bypass check distinguishes `honoured`, `bypassed`, `refused-ca`; an untested harness reports `untested`, and a grant cannot become `verified` over `bypassed`.

---

### Task 1: `stkclient`

**Files:**
- Create: `apps/node-agent/internal/stkclient/stkclient.go`, `stkclient_test.go`, `testmain_test.go` (process stub)

**Interfaces:**
- Produces:
  - `type Client interface { Version(ctx) (string, error); HandoverKey(ctx) (string, error); HandoverOpen(ctx, service string, envelope string) error; Verify(ctx, service, expectLogin string) (VerifyResult, error); Reload(ctx) error; RevokeLocal(ctx, service string) error; Env(ctx) (Env, error); Doctor(ctx) (DoctorReport, error); Install(ctx, InstallPlan) (InstallReport, error) }`.
  - `VerifyResult{OK bool; Login, Reason string}`, `Env{ProxyURL, CAPath string; Vars map[string]string}`, `DoctorReport{Isolation struct{Level, Method string; Reasons []string}}`.
  - `New(binary string, stateEnv map[string]string, run Runner) Client` where `Runner` is `func(ctx, name string, args []string, stdin []byte, env []string) (stdout []byte, err error)` (default: capped `exec`).
- Consumes: stk's documented JSON shapes (the table in the stk design).

- [ ] **Step 1: Write failing tests** with a stub runner: `HandoverOpen passes the envelope on stdin and never in argv`, `Verify parses ok/login/reason`, `non-JSON stdout is an error that does not echo stdout`, `timeout returns an error and kills the child`, `oversized output is capped`, `an old stk without --json is reported as ErrStkTooOld`, `errors never contain the envelope or env values`.
- [ ] **Step 2:** `go test -race ./internal/stkclient` — expect FAIL.
- [ ] **Step 3: Implement** with argument vectors only and a 64 KiB output cap.
- [ ] **Step 4:** run — expect PASS.
- [ ] **Step 5: Commit** `feat(node): stkclient wraps the stk CLI`.

### Task 2: Station setup — install stk as its own user

**Files:**
- Create: `apps/node-agent/internal/forgeapi/setup.go`, `setup_test.go`
- Modify: `apps/node-agent/cmd/agentpod-node/` (a `forge-api setup` subcommand beside the existing service commands; builder confirms the command-registration file), `apps/node-agent/cmd/agentpod-node/run.go` (call site for lazy setup on first deliver)

**Interfaces:**
- Produces: `forgeapi.EnsureStk(ctx, c stkclient.Client, opts SetupOptions) (DoctorReport, error)`; `SetupOptions{StkBinary string; ServiceUser string; AgentUIDs []int; StateDir string; Interactive bool}`; `apn forge-api setup [--user stk] [--agent-uid N]…` runs `stk install` (as root) and reports isolation; non-root with no existing separate-user install reports `same-user` and says exactly why and how to fix. `AgentUIDs` defaults to the uid(s) the node spawns harnesses as.
- Consumes: Task 1.

- [ ] **Step 1: Write failing tests**: `setup runs stk install once and is idempotent`, `non-root without an existing install reports same-user with a reason`, `agent uids default to the harness uid`, `setup never prints a passphrase or key`, `unsupported platform returns a clear error`.
- [ ] **Step 2:** run — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `go test -race ./...` — expect PASS.
- [ ] **Step 5: Commit** `feat(node): set up stk as the station's credential broker`.

### Task 3: `forge.api.*` gateway handlers

**Files:**
- Create: `apps/node-agent/internal/gateway/forgeapi.go`, `forgeapi_test.go`, `apps/node-agent/internal/forgeapi/policy.go`, `policy_test.go`
- Modify: gateway registration (beside `NewGitIdentityHandler` in `cmd/agentpod-node/run.go`, ~lines 250–275 on `main`)

**Interfaces:**
- Produces: handlers for `forge.api.deliver|policy|verify|revoke|status` (frame types from the contract). `deliver`: EnsureStk → write/replace the stk policy entry for `serviceName` (kind forge; provider; host from `instance`; scheme; repositories; preset; rules; allow_graphql; labels `{station, principal, grant}`) atomically into stk's policy file → `HandoverOpen(serviceName, sealed)` → `Reload` → `Verify` is separate (hub asks). Ack `{ok, isolation, stored}`. `policy`: replace the entry's rules/preset, `Reload`. `verify`: `stkclient.Verify` plus the Task 6 bypass check result; ack carries login/reason. `revoke`: remove the entry, `RevokeLocal`, `Reload`, remove harness wiring (Task 5); idempotent. `status`: which grants are present and the isolation level.
- `forgeapi.RenderPolicy(entry PolicyEntry) (yamlBytes []byte, err error)` and `forgeapi.MergePolicy(existing []byte, entry PolicyEntry) ([]byte, error)` — pure, preserve unknown operator content, reject names colliding with built-in services.
- Consumes: Tasks 1–2; contract verbs from the hub plan.

- [ ] **Step 1: Write failing tests** (stub `stkclient`): `deliver writes the policy entry, opens the envelope via stdin, reloads, acks stored`, `deliver replay is idempotent`, `deliver with no stk acks error not success`, `the ack and the policy file contain no token`, `revoke removes entry and credential and is idempotent`, `revoke of an unknown grant succeeds`, `policy replaces rules and reloads`, `MergePolicy keeps unrelated services and rejects a colliding built-in name`, `labels carry station/principal/grant`.
- [ ] **Step 2:** run — expect FAIL.
- [ ] **Step 3: Implement.** Policy file path comes from the install report; written `0640` owned by the stk user group-readable only if stk requires it, never world-readable; atomic temp+rename.
- [ ] **Step 4:** run — expect PASS.
- [ ] **Step 5: Commit** `feat(node): forge.api verbs`.

### Task 4: Capability advertisement and version gating

**Files:**
- Modify: `apps/node-agent/cmd/agentpod-node/run.go` (`extras.Capabilities`, ~line 280), `apps/node-agent/internal/extras/` (builder confirms), tests

**Interfaces:**
- Produces: the node advertises `forge.api` iff `stkclient.Version` succeeds with a version `>= 0.0.1` and a probe `stk doctor --json` parses; it re-evaluates on reconnect. Missing or old stk → capability absent and the verbs answer an error ack naming the reason (`stk-missing`, `stk-too-old`, `stk-not-runnable`).
- Consumes: Task 1.

- [ ] **Step 1: Write failing tests**: `advertises forge.api only with a usable stk`, `re-evaluates after stk is installed`, `verbs answer error acks when unavailable (not timeouts)`.
- [ ] **Step 2:** run — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run — expect PASS.
- [ ] **Step 5: Commit** `feat(node): advertise forge.api only when stk is usable`.

### Task 5: Harness wiring through stk's proxy

**Files:**
- Create: `apps/node-agent/internal/forgeapi/env.go`, `env_test.go`
- Modify: `apps/node-agent/internal/descriptor/spawn.go` (ACP spawn env merge, beside `WithSSHCommand` on `main`), `apps/node-agent/internal/descriptor/hermes.go` and any systemd-started harness descriptors (builder lists them from `registry.go`), terminal env at `run.go` (~line 106)

**Interfaces:**
- Produces: `forgeapi.BrokerEnv(c stkclient.Client, stationID string) (map[string]string, error)` returning stk's proxy and CA variables plus the placeholder variables for the station's grants (from `stk env --json`); `forgeapi.WithBrokerEnv(env []string, add map[string]string) []string` (descriptor values win only when they already set the same name). ACP spawns and terminals get it; for systemd-started harnesses the node writes a drop-in environment file at a node-owned path (mode `0600`, owned by the harness user) and restarts the harness once at first grant; a running harness keeps its old environment, so deliver's ack reports `needsRestart` when the harness was already running (the hub surfaces it).
- Consumes: Task 1, Task 3.

- [ ] **Step 1: Write failing tests**: `ACP spawn env contains the proxy and CA variables and placeholders for this station only`, `a different station's placeholders are absent`, `no service secret in the env (only placeholders)`, `systemd-started harness gets the drop-in with mode 0600`, `already-running harness is flagged needsRestart`, `revoke removes the env entries and the drop-in`, `NO_PROXY is never set by the node`.
- [ ] **Step 2:** run — expect FAIL.
- [ ] **Step 3: Implement.** The proxy credential appears only in the harness environment and the drop-in; it is not logged.
- [ ] **Step 4:** `go test -race ./...` — expect PASS.
- [ ] **Step 5: Commit** `feat(node): route a station's harness through stk`.

### Task 6: Bypass check per harness

**Files:**
- Create: `apps/node-agent/internal/forgeapi/bypass.go`, `bypass_test.go`
- Modify: the `verify` handler (Task 3)

**Interfaces:**
- Produces: `forgeapi.CheckBypass(ctx, c stkclient.Client, harness string, run ClientRunner) []ClientOutcome` where `ClientOutcome{Client string; Outcome string}` and outcomes are `honoured|bypassed|refused-ca|untested|failed`. It drives a local fake provider through stk's own probe (`stk doctor --probe --json`) for the generic clients (curl, python3, node, go) and, for harnesses the node knows (`registry.go`), the harness's own client where a non-interactive probe command exists; every harness without one reports `untested`. `verify`'s ack carries the outcomes; the hub treats any `bypassed` as `failed`.
- Consumes: stk slice 3 (`--probe --json`), Task 3.

- [ ] **Step 1: Write failing tests** with a stub: `bypassed client makes verify report failed`, `untested harness is reported untested not honoured`, `refused-ca is reported`, `probe output is parsed without trusting extra fields`.
- [ ] **Step 2:** run — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run — expect PASS.
- [ ] **Step 5: Commit** `feat(node): detect harness clients that bypass the broker`.

### Task 7: Live acceptance

**Files:**
- Create: `apps/hub/tests/integration/forge-api-live.md` (the runbook), `scripts/forge-api-acceptance.sh` (read-only checks plus the one approved write)

**Interfaces:** none (operational).

- [ ] **Step 1:** On a non-production station (not Super Chotu), grant a read preset on a scratch repository for a test agent account; verify `delivered` → `verified`; confirm a real repository read through the proxy; confirm a request outside the preset gets 403 and an audit row naming the rule; confirm the hub, node and transcript contain no token (search for the real value).
- [ ] **Step 2:** Rotate, then revoke; confirm the provider token is gone (`GET` with the old token → 401) and the station has no entry, credential, or environment residue.
- [ ] **Step 3:** Reassign the station; confirm the previous occupant's grant is `revoking` → `revoked` and the new occupant has none.
- [ ] **Step 4:** Offline-node revoke: stop the node, revoke, confirm the provider token is revoked immediately and the wipe happens on reconnect.
- [ ] **Step 5:** With the operator's explicit go-ahead only: Super Chotu files the already-approved Supertoolkit typed-argument bug through the broker; read it back and check title, body and author. Do not file it during development and do not use any other account's credential as a fallback.
- [ ] **Step 6:** Record findings in the PR description; file defects as issues. **Commit** `docs: forge API access acceptance runbook`.

---

**Not in this plan:** the console section (needs mockups first), Gitea and Bitbucket node-side differences (none expected; provider knowledge lives in stk and the hub), and fixing the four SSH-grant defects.

> **Plan amendment (2026-10-17, from hub plan Task 5):** the `forge.api.status` handler in Task 3 MUST return `publicKey` (the output of `stk handover key`, `stk-handover-v1:`-prefixed) in its result so the hub can seal credentials to this station's stk. The contract result gains this optional field in hub Task 5. A status call must succeed even when no grants exist (it is how the hub bootstraps a first grant).
