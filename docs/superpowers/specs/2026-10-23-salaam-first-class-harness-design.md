# Salaam as a first-class AgentPod harness

Date: 2026-10-23. Status: draft for operator review.
Scope: specify and measure. Nothing here changes code; the gaps below are fixed by the PRs in the plan at the end.
Measurement: `scripts/harness-conformance.mjs`, run against the staging Salaam station on workbench (results in the baseline section).

## 1. Why this spec exists

The first Salaam station on staging (workbench, `salaam:ef1e0dba83118266` = `station_046aa0c3-946b-47bd-add4-bb1826715edf`, agent `salaam-staging` `prn_89f06b68a0fa07724033`, board `brd_ceb6d1c7c02a4a6b`, roster full-auto) is detected and reports itself running. It cannot be used. The Health tab shows only a PID. Logs shows "Reconnecting…" forever. Files and Chat show "Couldn't reach the hub". The bridge backs off every cycle. Several agents were fixing these one at a time. This spec replaces that with one contract, one measurement and one ordered plan.

## 2. The harness contract

The contract comes from `apps/node-agent/internal/descriptor/descriptor.go`, from what the other descriptors provide (claudecode, codex, hermes, kilo, opencode, openclaw, pi), from the console station page tabs, from the bridge, and from the evidence routes. A first-class harness meets every item. Each item names the conformance check that measures it.

| # | Item | What a first-class harness provides | Check |
|---|---|---|---|
| C1 | Detection | `Detect()` finds the station with no hand-set paths. Key, harness, workspace and capabilities come from the host. | `detection` |
| C2 | Enrollment and binding | Nobody edits a file by hand. Enrollment or adoption writes everything the harness needs to accept work from this hub. | `salaam.binding` |
| C3 | Identity | The station has one occupant principal (`stations.principalId`) with an occupancy epoch. The harness acts only as that principal. | covered by C10/C11 |
| C4 | Health | `Health` fills `running, pid, cpuPct, memBytes, diskBytes, uptimeSec, lastActivity`. Others use `gatherPidMetrics(pid)`, a cached disk walk, and the newest file mtime as RFC3339. | `health.running`, `health.fields` |
| C5 | Logs | `logs` capability. `TailLogs` sends the last 500 lines, then follows by polling every 500 ms. | `logs` |
| C6 | Files | `fs.read` capability. `ListDir`/`ReadFile` are read-only and confined to the workspace. A path escape is refused with a 4xx, not a node failure. | `files.list`, `files.read`, `files.confined` |
| C7 | Config | Declared harness config (spec 2026-10-04 and phase 3): `GET /config` returns observations, and plan/apply work. | `config` |
| C8 | Skills/plugins | `skills.inventory` at minimum. The managed skill verbs are optional per harness. | `skills.inventory` |
| C9 | MCP | The station is eligible for the hub MCP proxy and honours operator-declared MCP servers. | `mcp.proxy`, `mcp.node-capability` |
| C10 | Interactive ACP | The console's "Start session" opens a session in each mode (Ask / Accept edits / Full auto). "Use configured station tools" (`mcpProxy`) is honoured. | `acp.list`, `acp.open.*` |
| C11 | Bridge work | The bridge finds the station ready, and dispatched cards run. For Salaam this means strict work v1 plus leases. | `bridge.readiness`, `salaam.strict-work` |
| C12 | Evidence | ACP sessions and runs produce transcripts that SuperWitness reads from `/api/evidence/*`. | `evidence.transcript`, `evidence.principal` |
| C13 | Matrix | Applies only to harnesses with a Matrix gateway (Hermes, OpenClaw). It does not apply to Salaam today. | n/a |
| C14 | Lifecycle and cleanup | `lifecycle` (Stop/Start) and `cleanup` where the harness keeps disposable state. | (not yet checked, see open question 6) |
| C15 | Updates | The node can report the harness version and say when it is behind the pinned version. | (not yet checked) |
| C16 | Error semantics | When the station or node fails, the console must render the hub's JSON message. When the hub refuses for authorization, it answers 403, not 502. "Couldn't reach the hub" appears only when the hub really is unreachable. | `errors.station-vs-hub` |

## 3. Salaam, item by item

"Owner" is the repo that does the work.

### C1 Detection — works
- Today: works since agentpod #763 (auto-discovery of `salaamBinary`/`StateDir`/`Workspace` and PATH). Evidence: `detection PASS`.
- Remaining: in manifest mode, `Detect()` validates the runtime instead of observing the operator socket. Both paths must be kept under test.

### C2 Binding — missing (the onboarding gap)
- Today: `~/.config/salaam/agentpod-pins.json` (org id, node id, station key, workspace) was written by hand on workbench. The node does not know the org id at enrollment. A bound daemon refuses every unadmitted session (`admission_required`, salaam `src/service.ts` `/v1/sessions POST`). The staging smoke had to change for this (salaam #45).
- Finding (verified in `internal/salaam/work.go`, `runtime.go`, salaam `src/service.ts`, `src/cli.ts`): strict work cannot be enabled by editing pins or by adding `work_control`.
  - Strict work is on only when the node itself launched Salaam from a reviewed host manifest at schema 6.
  - The node checks for `salaamManifest` + `salaamNodeBinary` in its config. Without them it answers "reviewed strict work host required".
  - With them it runs `<node> salaam.mjs host start --manifest M`. The startup receipt must carry `strict_work:{version:1}`. The node then asks the daemon for `work-capability`.
  - Salaam sets `enabled` only when `agentpodWork && agentpodWorkProgression`. Only `host serve` from a schema-6 manifest sets those.
- `work_control` is not configured by anyone, and it must not be. The daemon adds `{version:1, owner:'superpipeline'}` to its `/v1/agentpod/attach` reply when strict work is on and the run source is Superpipeline. `acp.ts` reads it there.
- What must be produced, in order:
  1. `agentpod-pins.json`: `{organization_id, node_id, station_key, workspace, hub_url}`.
  2. A `linux-systemd-station-v1` station config. It pins the workspace, the identity, the node binary as the files helper, `systemd-run`, `systemctl`, and a reviewed runtime root made by `scripts/prepare-salaam-station-runtime.py` (which runs as root).
  3. The host-plan input `{"mode":"agentpod", state, agentpod_config:<pins>, station_config:<file>, "strict_work_version":1}`, passed to `salaam host plan --config`. The output is the schema-6 manifest.
  4. The node config gains `salaamNodeBinary` + `salaamManifest`. The node starts the host from it.
- Nothing produces items 1–4 today: not estate, not node enrollment, not the hub. The only reference setup is `apps/hub/tests/integration/salaam-node-e2e.ts`, in station mode, with everything running as root.
- Design (zero manual steps):
  - The hub knows the org id (`tenants.externalId` where `externalSource='org-plane'`). It returns the org id in the enrollment response and in a new node verb `salaam.bind` (`{organization_id, node_id, station_key, workspace, hub_url, occupancy_epoch}`). The verb is sent when a Salaam station is first detected (adoption), or when its occupant or epoch changes.
  - The node writes the pins, writes the station config, runs `host plan`, records `salaamManifest`, and (re)starts the host. Each step is idempotent and keyed by a digest of its inputs.
  - Owner: agentpod (verb, node producer). Salaam (`host plan` is stable and versioned; `salaam bind --from-json` is optional sugar).
- Key rotation: model keys live in Salaam's own state, not in the pins. Rotating them restarts the host without re-planning. A pin change (new org, new epoch, moved workspace) means re-plan, a new manifest digest, and a host restart. Old admissions die with the old epoch. The authority check in `salaam-authority.ts` already compares the epoch.
- Re-binding: `salaam.bind` with a new epoch revokes outstanding leases (`revoke`), re-plans and restarts. The station stays the same row.

#### Operator decision: root controller or unprivileged node
The protected-station profile assumes a controller owned by root. Checks run as transient system units with a dynamic user. `host start` spawns `host run` as the node's user, so the node agent would have to run as root. That contradicts estate provision 304, where Salaam and the node run unprivileged as `salaam`.

| Option | Gains | Costs |
|---|---|---|
| A. Node agent runs as root on Salaam hosts | Matches the reviewed profile and the only e2e. Dynamic users and transient units isolate tools well. | Root is the blast radius of a node compromise. It breaks the estate convention, and every other harness's node is unprivileged. |
| B. Keep the node unprivileged. Add a small root-owned helper unit (`salaam-host@.service`) that starts `host run` from a manifest the node writes. The node talks to it over a socket with a fixed verb set. | Node stays unprivileged. Privilege is confined to one reviewed entry point. | New component. It needs a Salaam-side "launcher" profile, and the review must cover the socket. |
| C. Run the host in `--user` systemd with no dynamic users | No root anywhere | Loses the isolation the profile was reviewed for. Tool isolation then rests on `--tools-user` (salaam #46) alone. |

Recommendation: B. It keeps the reviewed isolation and the estate convention, and only one small unit runs as root. Until B exists, staging can run A on workbench only, to prove the rest of the chain.

### C3 Identity — partial
The occupant principal is checked on every admission (`assertSalaamAuthority`). The agent's tools ran as the same OS user as the daemon holding the model key. Salaam #46 (`--tools-user`) fixes that. The node must pass the tools user from the station config. Owner: salaam (#46), agentpod (station config field).

### C4 Health — partial
- Today: only `running` + `pid`. Evidence: `health.fields FAIL` (null cpuPct, memBytes, diskBytes, uptimeSec, lastActivity).
- AgentPod (node only):
  - cpu/mem/uptime: `gatherPidMetrics(daemonPid)`. The PID is in `/v1/health`.
  - disk: `statfs` on the workspace (it is its own loop filesystem), or the cached `diskUsage` walk.
- Salaam: `/v1/health.sessions[]` has no timestamps. Add `last_activity_at` (RFC3339) at the top level and per session. Until then, the node falls back to the newest file mtime under state.

### C5 Logs — missing (deliberately closed)
- Today: `TailLogs` returns "logs are not exposed as station files". `logs` is not advertised, but the console shows the tab regardless → "Reconnecting…". Evidence: `logs FAIL`.
- The closed surface was a deliberate earlier decision. `TestSalaamRequiresObservedBoundDaemonAndAdvertisesOnlyProvedCapabilities` pins it. This spec reverses it for logs, because daemon logs carry no session content. If Salaam logs ever include prompt text, that is a Salaam bug.
- AgentPod: `journalctl --user -u salaam -n 500 -o cat`, then `-f` (env from `usersystemd.userSessionEnv`). In the manifest/system-unit mode (option A/B), read the host unit's journal. Advertise `logs`.
- Console: gate the Logs and Files tabs on `logs` and `fs.read` like the other gated tabs. Then an unproved harness shows "not available", not a spinner.

### C6 Files — missing (deliberately closed)
- Today: stubs → hub 502. Evidence: `files.list FAIL`; hub direct body `salaam: station filesystem access is not enabled`.
- Decision: open read-only access to the workspace only. Never open the state directory: it holds sessions, transcripts, leases and keys.
- Implement with the `artifact.go` pattern (`fsops.Jail` + `EvalSymlinks` + `os.OpenRoot`), not `safeJoin`, which is not symlink-safe.
- The workspace is `drwxrws--- salaam:salaam-work` (setgid), and some subdirectories are `drwx--S---`. The node reads as the `salaam` user, so unreadable entries come back as an entry with an error, not a failure. Advertise `fs.read` only. No `fs.write`/`terminal` for Salaam.
- Owner: agentpod.

### C7 Config — partial
`salaam_config.go` exists, but staging reports `0 observation(s)`. The node must observe Salaam's provider/model and the operator-declared MCP set (salaam `docs/mcp.md`) as config keys. Owner: agentpod (observation), salaam (stable `config show --json`).

### C8 Skills — works (inventory)
`skills.inventory PASS` (empty inventory). Managed skill verbs are out of scope for now.

### C9 MCP — partial
The station is eligible for the proxy, and the operator has not turned it on (`mcp.proxy SKIP`). Salaam already supports operator-declared MCP. What is missing is the bridge from AgentPod's "Use configured station tools" (`mcpProxy` on session create) to the Salaam session's MCP list. ACP `session/new` already carries `mcpServers`, and Salaam must accept HTTP MCP entries there under admission. Owner: salaam (accept in the admitted path), agentpod (test).

### C10 Interactive ACP from the console — missing
- Today: `POST /api/stations/:id/acp/sessions` → 502 in all three modes. The hub's real answer is `Salaam execution authority was suspended or its dispatch grant was withdrawn` (`services/salaam-authority.ts`), measured with the staging `API_TOKEN` user. A console user may get further, but must also hold a dispatch grant.
- How admission coexists with chat: the admitted interactive path already exists in code, and this spec makes it the one the console uses.
  1. The hub builds a binding with `run: {source: "interactive", id: hub_session_id, epoch: 1}`, the station's principal and epoch, and the org id.
  2. `assertSalaamAuthority` requires the calling user's org-plane principal to hold `grant.mayDispatch` ⊇ the station principal.
  3. The node calls `admit` on the operator socket (`client.go`, request id `open:<hub_session_id>`) and receives `admission_id` + token.
  4. The node spawns `salaam acp`, which attaches with `/v1/agentpod/attach {admission_id, token}`.
  5. The lease is renewed while the session lives and revoked on close.
  6. Modes map to Salaam permission policy: ask → ask, accept-edits → auto-approve edits, full-auto → auto-approve all.

  Unadmitted `/v1/sessions` stays refused. That is correct.
- Gaps:
  - The refusal is returned as 502, which hides an authorization decision. It must be 403 with the reason.
  - The console must say "You don't have a dispatch grant for this agent", with a link to grant it.
  - The operator's own console identity needs `mayDispatch` on the station principal. Onboarding step "dispatch grant" (see the guild onboarding notes) must cover the station principal.
- Owner: agentpod (status mapping, console copy, onboarding), salaam (mode mapping).

### C11 Bridge strict work — missing
- Today: every cycle logs "Salaam strict work version 1 is not freshly available". Evidence: `bridge.readiness FAIL`, `salaam.strict-work FAIL`.
- Cause: C2. No reviewed host from a schema-6 manifest means no `work-capability {version:1, enabled:true}`.
- Shapes:
  - `salaam.work-capability` request: `{node_id, station_key, workspace}`. Response: `{version:1, enabled:true}`, strict.
  - A card needs `spec.salaam = {version:1, plan: SalaamWorkPlan}`.
  - Leases: `admit` / `renew` / `revoke` / `status` with `{binding, request_id, lease_sequence, reason}`.
- Readiness has no hub API. Add `GET /api/stations/:id/readiness` → `{ready, reason, checkedAt}` from the bridge's last probe. Then the console and the conformance test stop reading logs. Owner: agentpod.

### C12 Evidence — unmeasured
No session exists yet to read a transcript for. The staging `API_TOKEN` is not accepted by `/api/evidence/*` (401). The check needs a SuperWitness reader credential (open question 4). Salaam must emit ACP session updates that the hub persists like other harnesses (it already speaks ACP). Owner: agentpod (verify), salaam (none expected).

### C13 Matrix — not applicable
Salaam has no Matrix gateway. Board rooms come from the bridge.

### C14 Lifecycle/cleanup — missing
- Not advertised. With the node launching the host (C2), `Start`/`Stop` are the host start/stop verbs → advertise `lifecycle`.
- No `cleanup`: Salaam owns its state retention.

### C15 Updates — missing
Report `salaam --version` and the manifest digest in Health/inventory. Compare against `agentpod-pins.json`'s adapter pin and the ACP registry. Owner: agentpod.

### C16 Error semantics — failing
- Measured: the hub returns JSON 502 with CORS (`{"error":"salaam: station filesystem access is not enabled"}`), but `staging-hub.agentpod.dev` (Cloudflare) replaces any origin 502 with its own HTML page with no CORS headers. The console's `fetch` then throws, and `networkError` renders "Couldn't reach the hub". This is the cause of finding 11. It is not a console bug.
- Rule:
  - A node or station failure is 424 (Failed Dependency) or 503 with `{error, code:"station_unavailable"|"node_failed", detail}`.
  - Refusals are 403/409.
  - 502/504 are never sent by the hub on purpose, because edges rewrite them.
- Console: only a thrown fetch, or a response without the hub's JSON envelope, means "Couldn't reach the hub".
- Owner: agentpod (hub mapper, console copy).

Also observed: on staging, `Access-Control-Allow-Origin` is `http://localhost:5173`. The staging hub's allowed-origin config should name the staging console (open question 5).

## 4. Ordered implementation plan

Small PRs. Each turns specific conformance checks green.

| # | Repo | PR | Turns green |
|---|---|---|---|
| 1 | agentpod | Hub: stop emitting 502/504 for node or station failures (use 424/503 + code). Map authority refusals to 403. Console: gate Logs/Files tabs on capabilities, and render the hub message for any JSON error. | `errors.station-vs-hub`; acp/files failures become legible |
| 2 | agentpod | Node: Salaam health metrics (pid metrics, workspace statfs, mtime fallback for last activity) | `health.fields` (except a true lastActivity) |
| 3 | salaam | `/v1/health`: add `last_activity_at` top-level and per session | `health.fields` fully |
| 4 | agentpod | Node: Salaam `TailLogs` via the journal. Advertise `logs`. Update the pinned capability test with the reasoning. | `logs`, part of `capabilities` |
| 5 | agentpod | Node: Salaam read-only workspace files via `os.OpenRoot` jail. Advertise `fs.read`. | `files.*`, `capabilities` |
| 6 | agentpod | Hub: `GET /api/stations/:id/readiness`. Conformance reads it instead of docker logs. | `bridge.readiness` measurable anywhere |
| 7 | operator decision | Root vs helper (section 3, C2) | — |
| 8 | salaam | Launcher profile for option B, plus `--tools-user` from the station config (after #46) | prerequisite for 9 |
| 9 | agentpod | Hub `salaam.bind` verb plus enrollment org id. Node producer: pins → station config → `host plan` → manifest → start host. Idempotent by digest. | `salaam.binding`, `salaam.strict-work`, `bridge.readiness` |
| 10 | agentpod | Onboarding grants the operator `mayDispatch` on the station principal. Console dispatch-grant copy. | `acp.open.*` |
| 11 | salaam | Admitted session: mode mapping and accept `mcpServers` (HTTP) from `session/new` | `acp.open.*` in all modes, `mcp.proxy` when turned on |
| 12 | agentpod | Config observations for Salaam (provider/model/MCP) | `config` |
| 13 | agentpod | Lifecycle via host start/stop. Version and manifest digest in inventory. | lifecycle/update checks (added to the script with this PR) |
| 14 | agentpod | Evidence check with a SuperWitness reader credential. CI job that runs the conformance script against an ephemeral station. | `evidence.*` |

## 5. Conformance baseline (2026-10-23, workbench, writes allowed)

```
detection              PASS    harness=salaam key=salaam:ef1e0dba83118266 node=workbench (online, v0.1.102)
node.online            PASS    node workbench status=online
capabilities           FAIL    advertised=[inventory,health,acp,skills.inventory] missing=[logs,fs.read]
health.running         PASS    running=true pid=1414320
health.fields          FAIL    null: cpuPct,memBytes,diskBytes,uptimeSec,lastActivity
logs                   FAIL    HTTP 200, 0 frame(s) in 8s (console shows Reconnecting…)
files.list             FAIL    HTTP 502 (Cloudflare HTML page)
files.read             FAIL    listing failed
files.confined         FAIL    escape refused as 502 (want 4xx)
errors.station-vs-hub  FAIL    edge replaced the hub's 502 with non-JSON without CORS; hub direct: 502 {"error":"salaam: station filesystem access is not enabled"}
config                 FAIL    0 observation(s)
skills.inventory       PASS    skills=[] plugins=[]
mcp.proxy              SKIP    eligible=true declared=null serving=false state=off
mcp.node-capability    PASS    node advertises mcp.proxy
acp.list               PASS    0 session(s)
acp.open.ask           FAIL    hub direct: 502 {"error":"Salaam execution authority was suspended or its dispatch grant was withdrawn"}
acp.open.accept-edits  FAIL    same
acp.open.full-auto     FAIL    same
activity               PASS    0 item(s)
evidence.transcript    SKIP    no ACP session to read
evidence.principal     SKIP    credential not accepted by evidence API (401)
bridge.readiness       FAIL    backs off: Salaam strict work version 1 is not freshly available
salaam.strict-work     FAIL    needs a node-launched host from a reviewed schema-6 manifest; nothing produces it
salaam.binding         FAIL    pins written by hand; no producer at enrollment
salaam.tools-user      SKIP    not observable from the hub; salaam #46 open
7 PASS, 14 FAIL, 4 SKIP
```

The test was not validated against a second harness. staging has no non-Salaam station: umamios-x15 is online with zero stations.

## 6. Open questions for the operator

1. Root controller or unprivileged node (section 3, C2)? The recommendation is B, a root-owned helper unit.
2. Do you accept reversing the closed surface for logs and read-only workspace files, with the state directory never exposed?
3. Should "Start session" from the console require the operator to hold `mayDispatch` on the station's agent, as the code requires today? Or should owners of a station get an implicit interactive grant?
4. Which credential should the conformance test use for `/api/evidence/*` (SuperWitness reader)?
5. The staging hub sends `Access-Control-Allow-Origin: http://localhost:5173`. Should it be the staging console origin?
6. Should lifecycle (C14) be mandatory for first-class status, or optional as in the descriptor interface?

## 7. Addendum 2026-10-28: "Always allow" on the approval itself (operator ruling)

The goal's approvals offer every choice a person needs at the moment of asking. Until now the
per-agent standing rule ("Always allow workspace writes", AgentPod #566409c4) was a console switch
only. The operator ruled on 2026-10-28 that the approval itself offers it too:

- **Where.** A strict workspace-write approval that the standing rule would cover (a workspace
  write anywhere in the workspace, never a delete or a hidden path) offers, in this order:
  Approve once · Approve for this run (when run-grantable) · **Always allow** · Deny.
- **Words.** "Always allow <station display name> to write in its workspace" (the hub fills in the
  name; Salaam's "this agent" is the fallback).
- **Who.** Workspace owners and admins only. The board hides the button from everyone else and
  refuses their answer (`WORKSPACE_ADMIN_REQUIRED`). The hub is the real guard: it re-reads the
  answerer's role from the organization plane by their own principal, never trusting the board.
- **Effect.** The hub sets the same per-agent rule as the console switch (scope
  `workspace-write`, audited `via: approval`) and only then forwards the answer, which approves
  this write. Later writes are answered by the rule from the run's next lease renewal. If the rule
  cannot be set, or the answerer is not an owner/admin, the answer is refused in plain words and
  nothing is approved: nobody is told a rule exists when it does not.
- **Revocation** is unchanged: revoking the rule in the console reaches a run in flight at its next
  renewal.

Implemented by Salaam #(always-allow option), AgentPod #817 (contract + hub) and SuperPipeline
forge #55 (board).

## 8. Addendum 2026-10-28: a renewal adds a newly listed rule (operator ruling)

Live proof (card D) showed the write right after "Always allow" still asked: Salaam pinned a run's
rules at admission and a renewal could only revoke, so a rule set mid-run reached only the run's
next admission. The operator ruled on 2026-10-28 (option a):

- **Add at renewal.** A rule the hub lists at renewal that the run does not hold joins the run at
  once, with an `approval_rule.added` event. The hub renews right after setting the rule (AgentPod
  #820), so the run holds it before its next write.
- **Keyed by rule id.** A rule the run held and lost to revocation does not come back; turning
  "Always allow" on again creates a new rule id, which joins.
- **Revocation unchanged.** A rule the hub no longer lists ends at that renewal, for good.
- **The hub stays the only source of rules**; Salaam never creates one from an answer.

The proof crosses the boundary: the real authority's renewal feeds the real station write check
from one journal (Salaam `approval-rule-renewal-e2e`).

## 9. Addendum 2026-10-28: board reads served by the hub (operator ruling, option iii)

Parity with Hermes: an agent reads its own card and run, and searches the library, while it works.
The operator ruled on 2026-10-28 that no SuperPipeline or SuperLibrary credential goes to the
station. The hub serves the reads.

- **Tool.** Salaam gains one read-only tool, `salaam_board`, with actions `card` (this run's card
  and its handoff), `attempts` (this card's runs), `library_search {query}` and
  `library_get {item_id}`. Read-only, so it never asks for approval; its description says so.
- **Path.** The tool records a pending read in Salaam's journal and waits (bounded). The hub sees it
  in work status, serves it with its own board client and the agent's SuperLibrary token (both
  stay in the hub), and answers with `salaam.work-read`. The node relays that verb like
  `salaam.work-decision`; the answer is bounded in size.
- **Scope, enforced by the hub.** A read names no board or card: the hub uses the run's own card
  and board. Any card or board other than the run's is refused. Library search is filtered to the
  run's board; a library item whose provenance is another board is refused.
- **No credential on the station.** No token is sent to the station or written into `mcp.json`.
- **Failure.** If the hub is unreachable or a read is refused, the tool returns a plain-words
  error to the agent; the work goes on.
