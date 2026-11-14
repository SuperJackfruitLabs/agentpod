# Claims ledger — AgentPod docs voice rollout

Status: verify-stage evidence for the 23-page AgentPod docs voice rollout.

## Immutable revisions and scope

- PR base: `3850079f0105dc1555863cd6d85806addb2de671` (`origin/main`, including AgentPod PR #878).
- Voice guide: `SuperJackfruitLabs/sketchbook@29690e4397467bcf92ea7ef7e88b4e89cffba88f`, `ideas/2026-11-14-docs-voice-guide-v1/README.md`.
- Reference rollout: `SuperJackfruitLabs/superdispatch@77185fc39f3431a3ffeca6d05bf405561b58f1b0`, especially `start/first-placement.mdx`, `run/running-it.md`, `run/opting-a-board-in.md`, `placement/`, and `records/`.
- Scope: all 23 published pages under `docs-site/src/content/docs/` and this ledger. The 21 hand-authored pages receive voice edits. The two generated CLI references are reviewed and verified, but remain byte-for-byte generated from the binaries.
- Adjacent work: the shared theme was already merged at the base. `index.mdx` retains its `BentoHome` block and layout. This change touches no site setup, package, lockfile, component, style, product code, generated reference source, CI, or working note.
- Product evidence below is pinned to the PR base. No evidence citation depends on a later commit.

## Voice review

| Area | Result | Evidence |
|---|---|---|
| Home | pass | The existing Bento content remains intact. Prose below it now establishes a direct `we`/`you` narrator and tells the reader what each product promise buys them. |
| Tutorial (`start/first-node.md`) | pass | Five action steps each end in an observable result. One guest-list premise is introduced, developed once, and paid off at adoption. Commands, prerequisites and recovery remain literal. |
| Task pages | pass | `use/acp.md`, `use/cli.md`, `use/config.md`, `use/nodes.md`, `use/rooms.md`, `use/scan.md`, and `use/skills.md` now carry a real guide/reader relationship and natural results after action sequences. Exact commands and refusal material are unchanged. |
| Concept and reference pages | pass | Warm direct prose was added lightly to the remaining hand-authored pages. Tables, routes, fields, enums, limits, JSON and recovery remain plain. No running gag was added. |
| Generated references | pass | `reference/apn.md` and `reference/fleet.md` already use direct explanatory prose around exact generated material. They were not hand-edited; the generator equality tests pass. |
| Candour | pass | Private account-service prerequisites, partial forge-API coverage, same-user isolation, unknown scan results, disabled/missing optional integrations, config races and fail-closed behavior remain explicit. |
| Exact material | pass | No humour was added to commands, values, tables, warnings, recovery, payloads, generated text or reference output. Placeholder token headers use explicit shell variables rather than redaction marks. |
| Vocabulary and privacy | pass | Product casing and `workspace` meaning are unchanged. Personal/internal-looking examples in `use/boards.md` and `use/stations.md` were replaced with obviously synthetic labels. A scan found none of the removed names elsewhere in the 23 pages. |
| Originality | pass | The narrator, payoffs and guest-list premise are original to AgentPod; no wording, metaphor or joke was copied from SuperDispatch or RedwoodJS. |

## Tutorial payoff and running-gag audit

| Step | Action | Observable payoff |
|---|---|---|
| 1. Get an enrollment token | Create the token in **Nodes**. | The reader has a one-hour, single-use invitation for exactly one machine. |
| 2. Install the agent | Run the root or user installer. | A resident service is installed and has presented the enrollment token to the hub. |
| 3. Check it | Run `apn status`. | The local service and hub credential are both proved healthy; the node appears online. |
| 4. See what is on it | Run `apn detect`. | The reader has the local station inventory; detection changed nothing. |
| 5. Adopt a station | Adopt chosen stations in the console. | The chosen stations become manageable and unadopted runtimes remain untouched. |

The single running premise is the machine's place on the guest list:

1. introduced in step 1 as the enrollment token;
2. developed when two machines cannot both get through the door on one token; and
3. paid off in step 5: the machine made the guest list, but the reader still chooses which stations come inside.

No warning or recovery text is adjacent to a joke. The external-account prerequisite is stated before the tutorial begins and remains literal.

## Claims checked at the PR base

Each row covers the commands, flags, routes, settings, defaults, fields, enums, limits and behavioral claims on that page. Broad ranges are used where the page describes the complete contract of a module; the generated references are additionally held byte-for-byte by their generator tests.

| Page | Material checked | Base evidence |
|---|---|---|
| `index.mdx` | Outbound node connection; nine registered harnesses; detection/adoption boundary; station panels/capabilities; bridge, skills and hosting boundaries; scan command, findings and exit statuses. | `apps/node-agent/cmd/agentpod-node/registry.go:20-60`; `apps/hub/src/services/stations/registry.ts:1-459`; `apps/hub/src/routes/station-lifecycle.ts:1-112`; `apps/hub/src/routes/station-cleanup.ts:1-184`; `apps/node-agent/cmd/agentpod-node/scan.go:1-66`; `apps/hub/src/auth/org-plane/config.ts:1-132` |
| `start/what-it-is.md` | Attach-first boundary; panel list; capability gating; bridge behavior; three-tier architecture; provisioning substrates; AgentPod/SuperPipeline authority split. | `apps/node-agent/cmd/agentpod-node/registry.go:20-60`; `apps/hub/src/routes/stations.ts:1-380`; `apps/hub/src/services/stations/registry.ts:1-459`; `apps/hub/src/services/bridge/loop.ts:1-410`; `apps/hub/src/index.ts:1-732` |
| `start/concepts.md` | Node, harness, station, purpose, principal kinds, grants, room and hub definitions; nested stations; capability refusal; token-derived dispatch authority. | `apps/hub/src/services/stations/registry.ts:1-459`; `apps/hub/src/auth/org-plane/verify.ts:1-169`; `apps/hub/src/auth/org-plane/grants.ts:1-113`; `apps/hub/src/services/matrix-as/stations.ts:1-173`; `apps/node-agent/cmd/agentpod-node/registry.go:20-60` |
| `start/first-node.md` | Hub prerequisite; one-hour/single-use/atomic enrollment; idempotent re-enrollment; install platforms and service types; `apn status`, `apn detect`; v0.1.98 detector list; adoption boundary. | `apps/hub/src/services/nodes/enrollment.ts:1-279`; `apps/hub/src/routes/enrollment-tokens.ts:1-70`; `apps/node-agent/scripts/install.sh:1-445`; `apps/node-agent/cmd/agentpod-node/service_cmds.go:1-639`; `apps/node-agent/cmd/agentpod-node/registry.go:20-60`; `apps/landing/src/pages/index.astro:5-38,450-453` |
| `reference/apn.md` | Every command, subcommand, flag, environment variable, default, exit status, credential rule and output contract. | `apps/node-agent/internal/nodecli/reference.go:1-398`; `apps/node-agent/cmd/agentpod-node/main.go:1-304`; `apps/node-agent/cmd/agentpod-node/reference_test.go:1-59`; exact equality rerun by `go test ./cmd/agentpod-node -race` |
| `reference/fleet.md` | Every verb, subverb, flag, environment variable, default, limit, exit status, credential rule and output contract. | `apps/node-agent/internal/fleetcli/reference.go:1-99`; `apps/node-agent/internal/fleetcli/reference_fleet.go:1-217`; `apps/node-agent/internal/fleetcli/reference_stations.go:1-517`; `apps/node-agent/internal/fleetcli/reference_skills.go:1-250`; `apps/node-agent/internal/fleetcli/reference_admin.go:1-291`; `apps/node-agent/cmd/agentpod-fleet/reference_test.go:1-49`; exact equality rerun by `go test ./cmd/agentpod-fleet -race` |
| `use/acp.md` | `--list`, `--station`, `--session`, `--hub`, token precedence, unenrolled-client behavior, stdin/stdout proxying and transcript ownership. | `apps/node-agent/cmd/agentpod-node/acp.go:1-88`; `apps/hub/src/routes/station-acp.ts:1-587`; `apps/hub/src/services/evidence/transcript.ts:1-173`; `apps/hub/src/mcp/tools.ts:1-206` |
| `use/boards.md` | Three signed public doors; bridge configuration and roster fields; 10-second reconciliation, poll/backoff/heartbeat/timeout behavior; wake, lease and strict-run behavior; gates, questions, checks, versions, cooling-off, attention and SuperToolkit approvals. | `apps/hub/src/services/bridge/config.ts:1-174`; `apps/hub/src/services/bridge/loop.ts:1-410`; `apps/hub/src/services/bridge/roster.ts:1-542`; `apps/hub/src/services/bridge/work-wake.ts:1-57`; `apps/hub/src/services/bridge/permission.ts:1-195`; `apps/hub/src/routes/admin-bridge-agents.ts:1-241`; `apps/hub/src/services/bridge/push-subscription.ts:1-183`; Treaty links named on the page are contract references |
| `use/cli.md` | Binary/credential separation; install and update behavior; device login/token precedence; command groups, flags and help; station, forge, skills, plugin and bridge surfaces. | `apps/node-agent/internal/fleetcred/device.go:1-259`; `apps/node-agent/scripts/install-fleet.sh:1-145`; `apps/node-agent/cmd/agentpod-node/main.go:1-304`; `apps/node-agent/internal/fleetcli/reference*.go` ranges above; both generated reference tests |
| `use/config.md` | Declaration levels/scopes; value shapes; three policies; seven settings; comparison states; opt-out precedence; plan/digest/apply/conflict/restart behavior; console parity; adopt-time reconciliation; ten refusal codes and status families. | `apps/hub/src/services/harness-config/harness-config.ts:1-562`; `apps/hub/src/routes/harness-config.ts:1-829`; `apps/hub/src/db/schema/harness-config.ts:1-56`; `apps/node-agent/internal/descriptor/hermes/hermes_config.go:1-583`; mechanically named CLI commands/subcommands pass `apps/hub/tests/unit/docs-claims.test.ts:114-292` |
| `use/errors.md` | Closed error-kind vocabulary; normalization/attempt behavior; one-error and recovered-fallback rules; OpenClaw/Pi error plugins; Hermes live plugin boundary. | `packages/contract/src/acp-session.ts:128-157`; `apps/hub/src/services/acp/turn-error.ts:1-507`; `apps/node-agent/cmd/agentpod-node/openclaw_errors.go:1-161`; `apps/node-agent/cmd/agentpod-node/pi_errors.go:1-123`; `apps/node-agent/cmd/agentpod-node/hermes_live.go:1-216` |
| `use/grants.md` | `mayDispatch` fail-closed semantics; human-only dispatchable read; grant CLI; dispatch-vs-operation boundary; principal suspension; node credential boundary. | `apps/hub/src/routes/fleet-dispatchable.ts:1-91`; `apps/hub/src/auth/org-plane/grants.ts:1-113`; `apps/hub/src/services/control/grant-reach.ts:1-104`; `apps/node-agent/internal/fleetcli/reference_admin.go:1-291` |
| `use/nodes.md` | Status blocks/exit code; start/stop/restart persistence; platform logs; service install/uninstall/idempotency; update/restart behavior; enrollment flags/env; node removal, force, provisioned/bridge refusals and audit. | `apps/node-agent/cmd/agentpod-node/service_cmds.go:1-639`; `apps/node-agent/internal/service/service.go:1-131`; `apps/node-agent/internal/nodecli/reference.go:1-398`; `apps/hub/src/services/nodes/enrollment.ts:1-279`; `apps/hub/src/routes/nodes.ts:1-602` |
| `use/panels.md` | Capability table/gating; filesystem verbs; lifecycle audit/order and health result; cleanup plan/apply; git-only changesets; skills inventory; Salaam timeline/restore; approval rules; plugin, voice and git-identity boundaries. | `apps/hub/src/routes/station-lifecycle.ts:1-112`; `apps/hub/src/routes/station-cleanup.ts:1-184`; `apps/hub/src/routes/station-changeset.ts:1-167`; `apps/hub/src/routes/station-skills.ts:1-49`; `apps/hub/src/routes/station-timeline.ts:1-147`; `apps/hub/src/routes/station-writes.ts:1-244`; `apps/hub/tests/unit/docs-claims.test.ts:294-315` |
| `use/rooms.md` | Identity/room/space creation; encryption; permission options, 30-minute expiry and exact-request binding; held mid-turn messages; push privacy and Live Activity exception; optional bridge boundary. | `apps/hub/src/services/matrix-as/stations.ts:1-173`; `apps/hub/src/services/matrix-as/station-room.ts:1-244`; `apps/hub/src/services/bridge/permission.ts:1-195`; `apps/hub/src/services/push/gateway.ts:1-313`; `packages/contract/src/acp-session.ts:128-157` |
| `use/scan.md` | Two scan families; no-hub/no-network behavior; standalone release binaries; SHA verification command; exit codes/options; unknown semantics; no CVE feed; posture surface. | `apps/node-agent/cmd/agentpod-node/scan.go:1-66`; `apps/node-agent/internal/posture/scan.go:1-121`; `apps/node-agent/scripts/install.sh:1-445`; `.github/workflows/release.yml:1-220` |
| `use/skills.md` | Inventory observations and coverage; non-execution boundary; plan/inspect/apply digest; rollback; admission/immutability; release/cohort/canary behavior; native placement and verification. | `apps/hub/src/routes/skill-management.ts:1-638`; `apps/hub/src/services/skills/artifacts.ts:1-176`; `apps/hub/src/services/skills/operations.ts:1-520`; `apps/hub/src/services/skills/release-cohorts.ts:1-52`; `apps/hub/src/services/skills/release-canary.ts:1-98`; `apps/hub/src/routes/station-skills.ts:1-49` |
| `use/stations.md` | Detection/adoption/tree/capabilities/purpose; Matrix identity; git identity and author environment; forge API modes, policies, states, limits, rotation/revocation/isolation and acknowledgements; staffing and cleanup boundaries. | `apps/hub/src/services/stations/registry.ts:1-459`; `apps/hub/src/services/matrix-as/stations.ts:1-173`; `apps/hub/src/services/forge/station-git-identity.ts:1-297`; `apps/hub/src/routes/station-forge-api.ts:1-559`; `apps/hub/src/services/forge-api/station-forge-api.ts:1-136`; related forge-api service modules at the base |
| `use/voice.md` | Transcription flow/settings/fallback and encrypted key handling; speech modes/default; deterministic voice assignment; truncation; text-first and failure behavior; encrypted/quiet voice events. | `apps/hub/src/routes/transcription-settings.ts:1-317`; `apps/hub/src/routes/speech-settings.ts:1-407`; `apps/hub/src/services/speech/transcription-client.ts:1-176`; `apps/hub/src/services/speech/speech-client.ts:1-167`; `apps/hub/src/services/speech/speech-settings.ts:1-574`; `apps/hub/src/services/speech/transcription-settings.ts:1-475` |
| `build/auth.md` | Discovery response; accepted algorithm/signature/issuer/audience/expiry/entitlement and claims; header/query boundaries; dispatch authority; status families; static-token boundary. External issuer behavior listed below remains unverified. | `apps/hub/src/routes/org-plane-discovery.ts:1-14`; `apps/hub/src/auth/org-plane/config.ts:1-132`; `apps/hub/src/auth/org-plane/verify.ts:1-169`; `apps/hub/src/auth/org-plane/grants.ts:1-113`; `apps/hub/src/mcp/auth.ts:1-60`; `apps/node-agent/internal/fleetcred/device.go:168-259` |
| `build/catalog.md` | Reader authorization; three routes and response fields; kinds, proof enum/order, source/proof mapping and stale-read boundary. | `apps/hub/src/routes/capability-catalog.ts:1-88`; `apps/hub/src/services/catalog/build.ts:1-143`; `apps/hub/src/services/catalog/facts.ts:1-180`; `apps/hub/src/services/catalog/types.ts:1-54` |
| `build/mcp.md` | `/mcp` auth; four tool names, parameters and self/ownership scoping; artifact refusal limits; initialization rules; person boundary; proxy compatibility and Salaam managed profile behavior. | `apps/hub/src/mcp/server.ts:1-107`; `apps/hub/src/mcp/tools.ts:1-206`; `apps/hub/src/mcp/auth.ts:1-60`; `apps/hub/src/services/stations/mcp-proxy.ts:1-355`; `apps/node-agent/internal/salaam/mcp.go:1-268`; `apps/node-agent/internal/mcpproxy/mcpproxy.go:1-562`; `packages/contract/src/salaam-mcp.ts:1-197`; tool names mechanically checked by `apps/hub/tests/unit/docs-claims.test.ts:69-82` |
| `build/services.md` | Principal-kind boundaries; catalog/bridge/evidence doors; roster fields/readiness/busy semantics; reader setting; scopes and evidence routes; cross-workspace 404. | `apps/hub/src/routes/bridge-roster.ts:1-237`; `apps/hub/src/services/bridge/roster.ts:1-542`; `apps/hub/src/routes/evidence.ts:1-644`; `apps/hub/src/auth/org-plane/verify.ts:1-169` |

## Corrections

No pre-existing product behavior, command, route, default, field, enum or limit needed a factual rewrite after comparison with the base. Eleven exact/privacy/verification corrections are recorded rather than changed silently; the last six correct overclaims introduced in the draft voice pass:

| Old material | New material | Evidence |
|---|---|---|
| `build/auth.md` used the generic angle-bracket placeholder `Authorization: Bearer <access token>`. | The copyable shell-variable placeholder is `Authorization: Bearer $TOKEN`. | Bearer verification: `apps/hub/src/auth/org-plane/verify.ts:61-169`; guide exact-material rule at the pinned guide revision. |
| `build/auth.md` mixed a `dev_…` prefix with an angle-bracket secret placeholder in the device-token exchange. | The request uses the explicit synthetic variable `$DEVICE_CREDENTIAL`. | Device exchange client: `apps/node-agent/internal/fleetcred/device.go:168-259`; guide exact-material rule at the pinned guide revision. |
| `build/mcp.md` named the header only as `Authorization: Bearer`, without a placeholder value. | It now says `Authorization: Bearer $TOKEN`. | MCP bearer parser: `apps/hub/src/mcp/auth.ts:1-60`. |
| `use/boards.md` used two person-like names in example notices. | Both examples use the explicitly synthetic `Reviewer A`. | Voice-guide privacy rule 8 at the pinned guide revision; no behavior or contract text changed. |
| `use/stations.md` used an internal-looking host plus two agent-like names in the example tree. | The example uses `example-node`, `writer-alpha`, and `reviewer-beta`. | Voice-guide privacy rule 8 at the pinned guide revision; station-tree behavior remains evidenced by `apps/hub/src/services/stations/registry.ts:1-459`. |
| The draft `use/nodes.md` payoff said `apn status` established that both checks passed even when the command reports a failure. | It now says the command shows whether the local and hub checks agree and that its exit code reports whether both passed. | `apps/node-agent/cmd/agentpod-node/service_cmds.go:421-499`. |
| The draft `use/nodes.md` payoff said any successful update command leaves the node current and restarted, which was false for successful `apn update --check`. | It now distinguishes check-only observation from a successful update and restart. | `apps/node-agent/cmd/agentpod-node/main.go:180-221`; `apps/node-agent/internal/selfupdate/selfupdate.go:105-194`. |
| The draft `use/nodes.md` grouped `restart` with persistent enable/disable state. | It now says `start` and `stop` persist enablement while `restart` leaves that choice unchanged. | `apps/node-agent/cmd/agentpod-node/service_cmds.go:251-419`; `apps/node-agent/internal/service/service.go:1-131`. |
| The draft `use/panels.md` implied that capability gating prevents every later operation failure. | It now makes the narrower guarantee: a panel is absent when its required capability is undeclared. | `apps/hub/src/routes/station-writes.ts:1-244`; `apps/hub/src/services/stations/registry.ts:1-459`. |
| The draft `use/rooms.md` said any late permission reply “changes nothing,” although a number sent after later conversation can become an ordinary message. | It now says a closed question cannot be approved; the existing ordinary-message boundary remains explicit below it. | `apps/hub/src/services/bridge/permission.ts:1-195`. |
| The draft `use/voice.md` said configuration alone makes a transcript appear, even though an external transcription request can fail. | It now conditions the payoff on successful transcription. | `apps/hub/src/services/speech/transcription-client.ts:1-176`; `apps/hub/src/services/speech/transcription-settings.ts:1-475`. |

## Unverified external-service claims

The AgentPod base proves its client contract and verifier expectations, but does not contain the private organization-plane implementation or deployment. These existing `build/auth.md` claims remain **UNVERIFIED** pending owning-repository/deployment evidence:

- device credentials last 90 days from last use;
- the issuer serves `/.well-known/openid-configuration`, `/.well-known/oauth-authorization-server`, and `/api/auth/jwks` at the documented paths;
- `/api/token/service`, `/api/token/agent`, and `/api/token/assertion` have the documented principal/scope behavior, including a two-minute assertion token.

The author asked for pinned evidence on card `card_d2b38565e604491c` in comment `cmt_918f66d4af78444a`. Their absence from this repository is not treated as evidence that they are false.

## Mechanical claims ratchet

No new factual surface was added. The existing ratchet already checks all 23 pages for:

- registered MCP tools;
- dispatched `apn` and `fleet` commands and second-level `fleet` subcommands;
- capability-gating table entries;
- internal links; and
- code-to-doc completeness for hub routes, environment settings, Matrix/relay event types and push events.

The generated-reference tests compare the complete `apn` and `fleet` pages with the binaries' command tables and source. Because the operator limited this rollout to page text, no product/test source was changed; the existing ratchets were exercised unchanged and passed.

## Real docs-only CI commands

The docs-only lane is defined at `.github/workflows/ci.yml:468-562`. The following commands were run from this checkout after the final page edits:

- `npm ci` in `docs-site`: pass — 352 packages added, 353 audited; npm reported 2 vulnerabilities (1 moderate, 1 high). No dependency or lockfile was changed in this docs-only rollout.
- Root `pnpm install --frozen-lockfile`: pass — all 10 workspace projects, 1,175 packages, lockfile unchanged.
- Root CI stand-in (`mkdir -p apps/console/.svelte-kit`; create `{}` only if absent), then `npm --prefix docs-site run build`: pass — Astro built all 24 routes, Pagefind indexed 24 HTML files, and the sitemap was generated. Astro emitted the existing warning that the optional `i18n` collection is absent/empty.
- `NODE_ENV=test bun test tests/unit/docs-claims.test.ts` in `apps/hub`: pass — **12 passed, 0 failed, 1,933 expectations**.
- `go test ./cmd/agentpod-fleet ./cmd/agentpod-node -race` in `apps/node-agent`: pass — both packages `ok` (237.465s and 87.786s). Go automatically fetched the module's requested `go1.26.4` toolchain.
- `git diff --check origin/main...HEAD`: pass.

An earlier local build invocation put the console tsconfig stand-in under `docs-site/apps/` rather than at the repository root and failed with `Tsconfig not found .../apps/console/.svelte-kit/tsconfig.json`. Repeating the workflow's exact root-relative setup produced the successful result above. The mistaken path is untracked/ignored and is not part of the patch.

## Verify-stage rerun after corrections

Verify independently inspected the 23-page source set and the complete base-to-head diff, checked every ledger citation path/range mechanically (**124 parsed citations, 0 missing paths, 0 ranges past end-of-file**), and corrected the six draft overclaims recorded above. The exact docs-only commands were then rerun on the final tree:

- `npm ci` in `docs-site`: pass — 352 packages added, 353 audited; npm again reported 2 vulnerabilities (1 moderate, 1 high).
- Root `pnpm install --frozen-lockfile`: pass — all 10 workspace projects, 1,175 packages, lockfile unchanged.
- Root-relative console tsconfig stand-in plus `npm --prefix docs-site run build`: pass — Astro built **24 pages**, Pagefind indexed **24 HTML files**, and the sitemap was generated; the existing optional-`i18n` warning remained.
- `NODE_ENV=test bun test tests/unit/docs-claims.test.ts` in `apps/hub`: pass — **12 passed, 0 failed, 1,933 expectations**. The workstation had Bun 1.3.7; CI pins Bun 1.4.2.
- `go test ./cmd/agentpod-fleet ./cmd/agentpod-node -race` in `apps/node-agent`: pass for both packages. `go` was absent from `PATH`, so Verify invoked the already-downloaded module toolchain at `go1.26.4`; the uncached verification run completed in 152.243s and 59.994s, and the final post-edit rerun was cached.
- `git diff --check 3850079f0105dc1555863cd6d85806addb2de671...HEAD` plus the uncommitted Verify correction diff: pass.
- Privacy scan across all 23 page sources for the known removed/internal person, agent, host and station identifiers: 0 matches.
