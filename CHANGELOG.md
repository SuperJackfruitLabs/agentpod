# Changelog

All notable changes to AgentPod are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versioning: [Semantic Versioning](https://semver.org/).
Entries go under `## Unreleased`; a release-prep PR stamps them `## vX.Y.Z — YYYY-MM-DD`
(`sh .github/release/prep-release.sh vX.Y.Z`), and the release notes quote that section.

---

## Unreleased

### Added

- `fleet bench stage add|set --execution one-shot|remote --bench-node NODE`: a
  bench stage chooses how its agent works in the card's bench. `one-shot`, the
  default for every existing and new stage, is unchanged. A `remote` stage writes
  its registry profile on the bench node with launch `remote-v1` and no worker,
  and its checkpoint profile names the station and its own node as `executor`.
  The hub refuses it when the bench node lacks `bench.remote.credential`
  (`BENCH_NODE_UNSUPPORTED`), the station's node lacks `bench.remote.attach`
  (`STATION_NODE_UNSUPPORTED`) or the station is not Hermes
  (`REMOTE_HARNESS_UNSUPPORTED`). Only the configuration is stored here; the
  remote attempt itself comes in a later change. Migration 0139 adds
  `bench_stages.execution` and `bench_node_id`.
- Node verbs `bench.identity.ensure` and `bench.remote.attach|detach|status`,
  advertised as `bench.remote.attach`: a Hermes station gets its own bench SSH
  key (private half on the node only), and attach writes the bench certificate
  beside it, pins the bench host key in the gateway user's `known_hosts` and
  points the profile's `terminal:` section at the bench, `cwd` included.
  Detach restores `config.yaml` and `known_hosts` byte for byte, or leaves a
  terminal section someone else has since changed (`terminal_changed`). Attach
  refuses a profile that would copy credential files to the bench, and an
  expiry sweep detaches five minutes after a certificate lapses. Neither verb
  restarts the gateway.
- `agentpod-live` 0.3.0: while its profile is attached to a remote bench, the
  plugin rewrites replace-mode `patch` calls into the equivalent V4A patch (the
  only form ACP edit approval can preview remotely), blocks `replace_all` with
  a hint toward V4A, and tells each new session which bench and directory it
  works in.

## v0.1.133 — 2026-11-24

### Added

- A card's bench is cleared once the card is done, terminal, cancelled or dormant.
  Every five minutes the hub reads each benched card through its latest run and,
  when the card is `completed`, `rejected` or `failed`, `canceled`, archived or
  deleted, or neither it nor its attempts changed for `BENCH_DORMANT_AFTER_HOURS`
  (default 72, `0` turns dormancy off), asks each node the card used to reclaim its
  bench. Never for a card with an attempt in progress, a held lease or an
  unsettled journal; a failed reclaim only logs and is asked again next sweep.
  Migration 0138 adds `bench_clearances`. SuperBench's own idle grace
  (`fresh_reclaim_idle_hours`) should be set above the hub's dormancy limit, or it
  clears warm benches first.
- The node manages Hermes's `agent.reasoning_effort` as a reconcilable setting
  (`hermes.agent.reasoning_effort`, per profile, restart to take effect), so a station can be
  told to reason, and with `hermes.plugins.stream_reasoning_deltas` to stream its thought
  deltas, through `fleet config` instead of a hand edit. Needs the node at this release.

### Fixed

- A gate SuperPipeline cancels (its card moved by hand or archived while the review
  was pending) now closes its card in chat. The gate sweep reads it as `cancelled`
  and posts treaty's `cancelled` receipt, naming nobody, once; a cancelled gate the
  hub never posted is never posted. Before, the card stayed open and answerable.
  SuperExchange settles it the same way. Needs treaty v0.0.18.

### Changed

- A settled card keeps its bench. The hub no longer asks the node to reclaim a
  card's bench once its checkpoint settles: one card keeps one bench from stage to
  stage and across review bounces, so the next agent finds it warm.
- `fleet bench stage set NAME --keep-bench` now means the hub never clears that
  stage's benches, even once a card is done, cancelled or dormant.
- With the suite's event relay configured (`TREATY_RELAY_DELIVERY_SECRET`), a board's push config
  subscribes none of the eleven decision events: the relay delivers them all, so the push no
  longer duplicates them. Each board's config is re-registered with an empty list within five
  minutes of a restart. A hub without a relay keeps getting them by push, and the relay's own
  `elicitation.pending` config stays. The relay's filter must carry all eleven, as staging's and
  production's do.
- The capability catalog (`/api/catalog/*`) and bridge roster (`/api/bridge/*`) refuse with
  snake-case codes (`not_found`, `invalid_station`, `invalid_board`, `invalid_principal`) instead
  of the free-text `not found` and `invalid station` they answered before, as treaty v0.0.19's
  `capability-catalog` contract says. Statuses are unchanged; no consumer read the old words.
- The push doors (`/public/bridge/superpipeline/push` and `/work`) accept only the
  suite's `x-treaty-signature`. The older `X-Superpipeline-Signature` fallback is
  gone: a push carrying only it is refused (401). SuperPipeline stops sending it in
  v0.0.37; release this only once that version is live.

## v0.1.132 — 2026-11-23

### Fixed

- A SuperPipeline decision event for a board this hub will never carry (on no
  roster here and never dispatched for, such as a board SuperExchange carries) is
  answered `200 {"status":"ignored"}` on both doors instead of 503, so the relay
  no longer spends ten retries on it. A rostered board with no dispatch yet is
  still 503.
- `fleet bench stage add|set` for a stage whose cards choose (`--cards-choose`)
  prints its policy under `cardCheckpointPolicy`, the SuperPipeline stage field it
  goes in; it was printed as `checkpointPolicy`, the field SuperPipeline refuses a
  v2 policy in, and a person copying it got it wrong. A fixed stage still prints
  `checkpointPolicy`. The next step names the field and, for a card stage, says
  to clear `checkpointPolicy` in the same PATCH. `fleet bench doctor` (and its
  `--json` report) names the policy the same way.
- `fleet bench stage set NAME --keep-bench` and `--keep-bench=false` report the
  flip in the reply's `changed` (`keepBench`, before and after); it answered
  `changed: {}`.

### Added

- A settled card's bench is reclaimed. Once the hub records a card's checkpoint
  settlement, it asks the node to reclaim that card's bench (`bench.reclaim`), so
  settled benches stop holding their tree and quota until SuperBench's idle sweep
  and a host no longer fills after a few cards. Per stage and on by default;
  `fleet bench stage set NAME --keep-bench` keeps them. Never for a card with
  another unsettled attempt, a held lease or a bench that is not ready; a failed
  reclaim only logs. A card that comes back gets a fresh bench from its card
  branch. Migration 0136 adds `bench_stages.keep_bench`. The node's user must be a
  SuperBench operator.
- Proposed: a bench stage whose cards choose their repositories (treaty v0.0.16).
  `fleet bench stage add|set --cards-choose [--default-repo N ...]` keeps `--repo`
  as the stage's allow-list and prints a `cardCheckpointPolicy`
  (`run-checkpoint-policy.v2`) for SuperPipeline. Only that stage's claims send
  `checkpointProtocols: [checkpoint-claim.v1, checkpoint-claim.v2]`; the hub
  recomputes each claim's narrowing from the stage policy and its `selection` and
  refuses any difference in digest, order or membership. A claim's repositories
  must be an ordered subset of the allow-list (a fixed stage's still name all of
  it), and the node prepares each card's bench with only its choice, filtered by
  name from the registry's allow-list. A card whose bench exists with another set
  is refused, named: the choice is frozen once the bench exists. Every other
  claimant and every v1 claim is unchanged. See `docs/BENCH_REGISTERED_LAUNCH.md`.

- `fleet bridge add --credential-source station-plane` adds a source row with no
  `--token`. With no `--principal`, `--organization` or `--audience`, the hub fills
  in the station's occupant, the workspace's organization and its own SuperPipeline
  origin (`fleet bridge set KEY --credential-source station-plane` does the same for
  an existing row). The admission checks and the trial exchange are unchanged.
- The node answers `bench.registry.status|set|remove` (capability
  `bench.registry.manage`): the hub writes one stage's profile into the node's
  private coordinator registry, atomically and validated as the whole new file, and
  the coordinator reloads it with no restart. The reply carries the registry's
  `registry_sha256` (the digest of the bytes now installed), the worker and
  coordinator pins against the installed bytes, the bench daemon's reachability and
  free space, and each served target; never a clone URL or an argument. A registry
  may now hold no stage, and `repin` re-pins the worker and node digests after an
  update. Host fields (socket, roots, worker path) are never written from the hub.
- `fleet bench stage add|set|list|rm`: one SuperBench stage set up from the hub.
  `add` creates (or upgrades) the station's `station-plane` roster row, writes the
  node's registry profile through `bench.registry.set`, and builds the hub's
  checkpoint profile from the station, the roster, the hub's own service grant and
  the node's reply, so `registry_sha256` is the node's own and nobody computes it.
  Profiles live in a new `bench_stages` table (migration 0135) and are selected
  with no restart; moving a stage's board is one `stage set NAME --board B`, which
  moves its roster row too. Other stages on the node are re-pinned in the same
  write. No reply, row or audit entry holds a clone URL or a worker argument.
  Upgrade: an empty table changes nothing, and the private profile file keeps
  loading; its profiles are adopted into the table the first time the hub rewrites
  their node's registry. See `docs/BENCH_REGISTERED_LAUNCH.md`.
- `fleet bench doctor NAME | --station S`: one PASS or FAIL line per check before a
  stage's first card, each failure with its next step. It checks the hub's
  coordinator flag, control pair and SuperPipeline audience; the station's occupant
  and node; the node's registry, benchd (reachable, managed, free space on both
  volumes), and the worker and node digests against the installed bytes; the roster
  row, its source, a trial exchange of the agent's grant (`claim`, `run`), the
  run-only MCP token and the owner's dispatch grant; the hub's service grant
  (`checkpoints:submit`, `checkpoints:read`); and the stage's pins against what the
  node serves. It then prints the Accounts and SuperPipeline steps no verb takes and
  the stage's `checkpointPolicy`. It changes nothing and exits 1 on a failure.

- The event relay is a door for all eleven SuperPipeline decision events, not only
  `gate.pending`. An event that arrives by both the relay and the push is acted on
  once, by its shared id `<boardId>:<seq>`, claimed in a new table
  `superpipeline_event_receipts` (migration 0137, pruned after 7 days). The push
  subscription is unchanged.

### Changed

- Org-plane tokens are verified with treaty's `verifyAccessToken`: 30 s leeway on
  `exp`, `nbf` and `iat`; a lifetime over 300 s, a token with no `kid`, a
  `mayDispatch` that is not a prn, or an `ent` without the product is refused. An
  unknown `kid` refetches keys at most once per 30 s. Accounts mints no token these
  rules refuse.
- The push doors verify the suite's `x-treaty-signature` (timestamp, event id and
  body, 300 s window). The older `X-Superpipeline-Signature` is still accepted, only
  when the new header is absent. The doors answer by the receiver status contract: a
  board this hub has not mapped is 503 (was 404), a body that is not the event it
  names is 400, an unknown type is 200 and ignored.
- The hub's SuperPipeline client is held to treaty's `agent-work.v1` and
  `decisions.v1`: responses are read with checks, a claim refusal carries its
  `reason`, pending items with no board are skipped, and chat write-backs time out
  after 10 s.
- Treaty pins move to 0.0.17 (`treaty-contracts`, `-cloudevents`,
  `-ecosystem-identity`, `-matrix-events`). 0.0.16 added the proposed per-card
  repository contracts; 0.0.17 adds contracts for other products and changes none
  of the checkpoint or agent-work files.

### Fixed

- Harness scratch no longer dirties a bench checkout: the registered worker adds
  `/.hermes/cache/` to each bench member's own `info/exclude` before the harness
  starts, so SuperBench no longer refuses the checkpoint as dirty. The tracked
  `.gitignore` is not touched.
- A card whose Hermes run failed on a model error says why, in a closed sentence
  (for example HTTP 401 from the provider), carried by the node as `detail.task`.
  The provider's own text is never copied.

- The `fleet bench stage set|rm` reply field `repinned` is now
  `otherStagesRepinned`: it always named only the other stages on the node moved to
  its new digest, so on a one-stage node it read `[]` while `changed` listed this
  stage's own re-pinned fields.

- A checkpoint run still going no longer logs "checkpoint dispatch refused …
  attempt.unresolved" at warn on every recover read of its status: it holds new
  checkpoint claims as before, said once at info by the orchestrator.

- A checkpoint run longer than the hub's 60 second execute wait no longer pays the
  30 second fault backoff, with a warning, on every card. The benign park (the run
  is still going: `checkpoint.running` on the card) asks the loop to read its
  status again in 5 seconds, bounded at 10, logged at info. Real failures and every
  other timeout keep the backoff.
- A stage changed with `fleet bench stage set` (or `--repin`) reaches the running
  bridge loop. The loop built its checkpoint runtime once, at start, and every later
  cycle refused the new profile as `current.stale`, so no bench card was claimed
  until the hub restarted. The runtime is now looked up at each cycle's start and
  rebuilt only when the installed profile changed; a cycle never swaps its port, and
  an attempt made under the old profile is resolved as superseded.
- `fleet bench doctor` names `--repin`, not `--refresh`, when the node's served
  target differs because the installed worker or node bytes moved (or the registry
  is not served for a stale pin). It warns, with `--stage-id`, about a stage that
  has no SuperPipeline stage id (one adopted from the profile file).
- `fleet bench stage set` replies with `changed`: the stage's own pins that moved,
  each with its value before and after. `repinned` still names the other stages on
  the node moved to its new digest.

- The hub kept the node's `bench.registry.manage` capability: it was missing from
  the contract's `NodeCapability`, so the hello frame's parse dropped it and every
  `fleet bench` verb refused the node as one too old. A contract test now reads the
  node's sources and fails when any capability it advertises is unknown to the hub.
- A card whose run ended after its work was pushed says "the card moved" when
  SuperPipeline ended the run with outcome `moved` (a person's move ends the run
  now), not only when the run was unbound.

- A bridge row with a `station-plane` credential source can hold the run-scoped
  MCP token its harness spends, so an agent on a source row gets its SuperPipeline
  board tools on ordinary cards. Upgrading a token row to a source keeps that token
  and drops only the claim token. A source row still refuses a claim token
  (`fleet bridge set KEY --mcp-token spa_…`). Migration 0134 relaxes the CHECK.

## v0.1.131 — 2026-11-22

No changelog entries were written for this release; its changes are listed in its
release notes.

## v0.1.130 — 2026-11-17

### Added

- Proposed registered bench launch: a registry profile with `"launch": "registered-v1"`
  delivers the worker's task to the payload only as SuperBench finite stdin and
  reads its framed result from sealed stdout, then reads the run's receipt back
  and releases the lease. Lost replies recover through the receipt with the same
  request ID; nothing is resent. Off unless both the coordinator registry flag
  and the profile opt in. See `docs/BENCH_REGISTERED_LAUNCH.md`.
- The coordinator wire can refuse with `capacity_exhausted`; the hub reports it
  by name on the parked attempt and never re-sends prepare or execute.

- The private bench worker has an explicit `hermes-v1` adapter for bounded prompt
  input and binding-matched task results. It requires a separately prepared
  payload-owned Hermes home, executable, provider and model. No dispatcher enables
  it by default; installed access, provider readiness and the producer crossing
  remain separate verification requirements.

### Fixed

- Recognize the proposed SuperBench logical-capacity refusal only for ordinary
  operations at HTTP 422, preserving its bounded diagnostic without redispatch.
  Cancellation errors and unknown response codes remain closed.

## v0.1.129 — 2026-11-16

### Fixed

- Broker replies, failures and stream chunks are accepted only from the authenticated
  node selected for the request. Another enrolled node cannot consume its pending
  reply or close its stream (#885).
- Turn errors retain generic-before-plugin event ordering through finalization.
  Duplicate errors are recorded once; late audit and Salaam recovery results remain
  bound to the original turn and cannot reset a replacement turn (#887).
- An invalid opt-in checkpoint profile no longer interrupts unrelated bridge agents.
  Profile pins are loaded once per configured path, including failed loads, instead
  of rereading a private file on every polling cycle. Restart the Hub after editing
  the same profile file. Ordinary claims with an absent policy serialized as `null`
  retain their legacy behavior; actual checkpoint claims and non-null policies still
  require the dedicated path.

- **A board roster no longer calls a station busy for a parked run.** `GET
  /api/bridge/boards/:boardId/roster` counted `parked` dispatches as work in hand, but #786 parks a
  revoked strict run precisely so it stops holding the roster, and the bridge goes on claiming on
  the station. A placement service read such a station as busy for good. Only `working` runs (a
  run in progress, or one waiting on a permission answer) count now.

- Fixes found while rebuilding the console and checking every page with an accessibility sweep, among them: an open file's tab in Files had its close button nested inside the tab, which screen readers cannot reach (Delete now closes the focused tab, and the cross stays for the pointer); the rendered Markdown preview could not be scrolled from the keyboard; on a phone many buttons, links, radio buttons and checkboxes were smaller than a fingertip; and the Cleanup list's checkboxes could only be hit on the box itself, not on their row.

### Added

- Default-off dedicated checkpoint coordination, with a Hub-only reporting
  credential and authenticated enrolled-node checks. Migration **0131** creates the
  immutable `checkpoint_dispatches` attempt ledger automatically at Hub startup;
  this schema addition applies even with the feature disabled, but inserts no
  attempts or configuration by itself. The new
  `POST /api/nodes/:nodeId/bench-coordinator/current` route returns 404 unless the
  explicit coordinator flag is enabled. Neither the migration nor the route
  provisions a grant, enables a board policy or starts a pilot.
- Release assets include four version-pinned private worker helpers:
  `agentpod-bench-worker-linux-amd64`, `agentpod-bench-worker-linux-arm64`,
  `agentpod-bench-worker-darwin-amd64` and `agentpod-bench-worker-darwin-arm64`,
  covered by `SHA256SUMS`. Publishing these artifacts does not install the helper
  or enable checkpoint dispatch.
- Structured checkpoint diagnostics identify a loaded or unavailable profile
  snapshot, committed attempt phases and parked reconciliation, using closed
  error codes and work identifiers. Credentials, private paths, request/response
  bodies and child output are not logged by these diagnostics.

- **`agentpod_link_artifact` returns a version-pinned link.** Besides `url` (the item, which
  always opens its latest version) it returns `versionUrl` (`/a/<item>/v/<n>`), and the tool and
  the hub's MCP instructions tell agents to attach that, so a gate opens the exact version it asks
  a person to approve.

### Changed

- **The code is restructured into modules, with no change in behaviour** (the modularity work,
  PR #836). The hub's `services/` is 23 modules, each imported through its `index.ts` and
  layered so none imports up; its seven files over 1,000 lines are split (the largest,
  `acp-sessions.ts`, 3,514 lines, is now 21 files); the node agent's harness descriptors are
  one package per harness, and `apn`'s and `fleet`'s command tables and references live in
  `internal/`; the console's station page is split into components. Every split was pinned
  first by characterization tests against the old code. Routes, responses, database queries,
  Matrix, forge and bridge traffic, log lines and CLI output are unchanged.
- **Type-check and lint gates.** CI's `hub` job holds `bun run typecheck` at zero and the tests'
  type errors to a listed file; `pnpm lint:ts` (oxlint, type-aware) and `pnpm lint:go`
  (golangci-lint) are ratchets whose counts may only fall, and shipped TypeScript is clean of
  `any`, empty blocks without a reason, floating and misused promises, unused code and
  unnecessary assertions; the node agent's shipped Go code drops no error without saying so.
  Nothing for operators to do: no configuration, environment, schema or wire change. The hub's
  plain stdout lines (boot, migrations, the sweepers) are deliberately unchanged.
- **The console installs to a phone's home screen**: a web app manifest, the iOS home-screen
  tags, and the AgentPod mark on the dark plate as its icon.

- **The console is rebuilt on vibekit**, the suite's design system. It comes in four vibes (Daylight, Paper, Studio and Quiet), each in light and dark, chosen under Appearance in the account menu. With no saved choice the console follows the sun instead of the OS setting. Navigation stays put as you move between pages, and on a phone it becomes a bottom bar with a More sheet. Tables turn into cards on narrow screens, and every control is at least 44px under 1024px wide.
- **The old colour schemes, font pairings and custom themes are gone.** A person's old light or dark choice seeds the new Appearance setting once; everything else from the old theme settings is dropped.
- Building the console now needs Node 22 or newer (vibekit requires it); there are no new build variables.

## v0.1.22 — 2026-08-12

**Posture** — `apn scan`'s findings become fleet-visible, and, more urgently, become correct. Checking the scanner against real machines found it grading them **A** without opening the files it claimed to check.

### Fixed

- **`apn scan` reported false passes for Hermes and OpenClaw.** Its credential path list named files that exist on no machine we own — `config.json`, `credentials.json`, `gateway.json` — while the real files are `config.yaml`, `auth.json`, `.env`, `openclaw.json` and `gateway.systemd.env`. Not one path matched for either harness, so both graded clean having read nothing. The list is now rebuilt from running machines, and every entry carries the host and date it was verified on.
- **Per-station credentials were never checked at all.** Hermes keeps `auth.json`, `.env` and `config.yaml` in every profile; OpenClaw keeps `agent/auth.json`, `auth-profiles.json` and `auth-state.json` in every agent. A profile with world-readable credentials passed. Findings for these now carry the station they belong to.
- **A file's mode is not the same as its exposure.** A 644 file inside a 700 directory cannot be read by anyone else, and reporting it would be a false alarm. Every finding now requires *effective reachability* — the file grants read to a class **and** every ancestor directory grants traverse to it. Without this, correcting the paths above would have turned a correctly secured machine with 15 Hermes profiles into 15 criticals and a grade of F.

### Added

- **Station config directories are checked for being writable by others.** Files inside can all be owner-only while the directory holding them is group-writable, which lets another user *replace* an agent's credentials — invisible to any file-mode check.
- **`posture.scan`**, a node-level verb, surfaced as a Posture panel on the node page in the console. A station whose own credentials are exposed also shows a banner on its own page; host-wide findings stay on the node page rather than being repeated across every station sharing a harness.
- **Node-level capabilities**, carried in the `hello` frame. Because they ride the handshake they refresh on every connect, so they cannot go stale.

### Notes

- **Observe-only.** Nothing is stored and nothing is remediated from the console; findings carry the exact command to run. Continuous posture with staged remediation is a later horizon.
- **The fix only reaches a machine once that machine runs this release.** Until then `apn scan` there keeps reporting on the old path list.
- Verified on the fleet: superchotu went from ~5 checks to **48**, molt-bot from ~5 to **60** (55 of them per-station). Both still grade A — correctly, and now provably: superchotu's twelve `775` agent directories and molt-bot's fifteen `644` `config.yaml` files all sit under `700` ancestors, so all 27 would-be criticals are suppressed by the reachability rule rather than by luck.
- **No Windows support** — the reachability walk assumes POSIX mode bits.
- macOS binaries remain unsigned ([#228](https://github.com/rakeshgangwar/agentpod/issues/228), blocked on an Apple Developer account), so a macOS node re-prompts for permissions after self-updating.

---

## v0.1.21 — 2026-08-11

**Changesets** — see what an agent changed in a station's workspace without SSHing to the machine. Uncommitted edits, untracked files, and commits not yet on a base, in the console's new Changes tab.

### Added

- **`changeset.status`** — the summary for a station's workspace: the branch, the base, and the uncommitted and committed-not-on-base sides kept separate. They are different situations: one means the agent is mid-flight, the other means finished work is sitting on a machine.
- **`changeset.diff`** — a patch, whole-side or per-file, truncated on a rune boundary with the same contract as `fs.read`.
- **Untracked files are included.** Agents create files constantly and `git diff` shows none of them. Their content is fetched per-file rather than by staging them: `git add -N` would make them visible, but it writes to the index of a workspace an agent may be using.
- **The base says why it was chosen** — `explicit`, `upstream`, `default-branch` or `head`. A surprising diff on a machine you are not sitting at is otherwise unexplainable, and "no upstream, so you are only seeing uncommitted work" is a different situation from "diffed against your upstream". The chosen ref always resolves to its merge base with HEAD, so commits made on the base after the branch diverged do not show up as work the station never did.
- The capability is advertised **only** where the workspace is a git repository and `git` is usable, so stations without one show no tab rather than one that always errors.

### Fixed

- **A station's capabilities are now refreshed when its node connects.** `stations.capabilities` was previously written only at adoption, so a station adopted before a capability existed could never gain it — the node reported it on every detect and the hub kept serving the row it stored at adoption. Any new capability hit this. The refresh updates already-adopted rows only and never inserts; adoption stays an explicit act.

### Notes

- **Observe-only.** Nothing is stored: refresh and you get the workspace's current truth. Content-addressing a change and delivering it are a later horizon.
- **Requires a hub running the matching release.** The `/api/stations/:id/changeset/*` endpoints are new, and **the hub should be deployed before the fleet updates** — otherwise nodes advertise `changeset` to a hub that cannot refresh their stored capabilities, and no tab appears.
- Reads never mutate the repository, and run with `GIT_OPTIONAL_LOCKS=0` so they cannot contend with a working agent's own git operations.
- **No Windows support yet** — path handling assumes POSIX. Submodules report as the pointer moving, which is what `git` itself reports.
- macOS binaries remain unsigned ([#228](https://github.com/rakeshgangwar/agentpod/issues/228), blocked on an Apple Developer account), so a macOS node re-prompts for permissions after self-updating.

---

## v0.1.20 — 2026-08-11

**Doors** — reach a station from any ACP editor. `apn acp` makes a station on another machine look like a local agent to Zed, JetBrains, or anything else that speaks the Agent Client Protocol, including machines behind NAT or CGNAT, because the node dials out.

### Added

- **`apn acp --station <id>`** — spawned by an editor, it pipes the editor's stdio to the hub over WSS. It parses nothing: every protocol decision happens hub-side, where the ACP SDK lives, so `apn` carries no ACP library and no protocol version.
- **`apn acp --list`** — the stations you can attach an editor to, grouped by machine. Lists only stations that can actually host a session; an empty fleet and a fleet with no `acp`-capable stations get different messages, because they need different fixes.
- Attaching to an **existing** session replays its transcript, so joining a conversation mid-flight shows what has already happened rather than a blank pane.
- Permission prompts reach the editor. If the console is attached to the same session, **both are asked and the first answer wins**.

### Notes

- **This is the first release carrying `apn acp`.** On v0.1.19 and earlier the subcommand does not exist and an editor gets `unknown command` (exit 2).
- Requires a hub running **this release or later** — the `/api/acp/proxy` endpoint is new.
- Editor config uses the ACP custom-agent form, e.g. Zed's `agent_servers` entry with `"command": "apn"`, `"args": ["acp", "--station", "<id>"]`, and `AGENTPOD_TOKEN` in `env`. Prefer the environment variable over `--token`: a token on the command line lands in shell history and process listings.
- macOS binaries remain unsigned ([#228](https://github.com/rakeshgangwar/agentpod/issues/228), blocked on an Apple Developer account), so a macOS node re-prompts for permissions after self-updating.

---

## v0.1.19 — 2026-08-11

`apn scan` — a security check for the agent runtimes on a machine, needing no hub, no account and no network.

### Added

- **`apn scan`** checks the two ways an agent runtime gets taken over:
  - **Credential files other users can read.** Known credential paths per harness (openclaw, hermes, claude-code, codex, opencode) are checked for group- or world-readable modes. File *contents* are never inspected — telling someone their keys are exposed should not require reading their keys.
  - **Agents listening on every network interface.** A runtime bound to `0.0.0.0` or `[::]` rather than loopback is reachable by anything that can route to the box. Only agent processes are considered; this is not a general port audit.
- Graded report (`A`–`F`) with a specific remedy per finding, `--json` for scripting, and an exit code usable in cron: `0` clean, `1` warnings, `2` critical.
- A check that cannot determine an answer reports `unknown` and says why. It is never counted as a pass, and never worsens the grade either.

### Notes

- **Scope of the listener check:** harnesses driven over stdio — Codex, Claude Code and OpenCode under ACP — never bind a port, so on a machine running only those this check has nothing to report. It covers agents run in server mode, such as an OpenClaw gateway.
- **No CVE database.** Every check is a property of the machine as it is now, so the binary stays honest without needing updates.
- macOS binaries remain unsigned ([#228](https://github.com/rakeshgangwar/agentpod/issues/228), blocked on an Apple Developer account), so a macOS node will re-prompt for permissions after self-updating.

> Releases v0.1.14 – v0.1.18 were not written up here. They cover the ACP sessions program (multi-session, history, Claude Code and Codex adapters) and the UI revamp; see `git log v0.1.13..v0.1.18` for the detail.

---

## v0.1.13 — 2026-08-08

`apn` service CLI: status/stop/start/restart/logs, `service install`/`uninstall`, a grouped help system, and a thinner installer.

### Added

- **Service verbs** (#199)
  - `apn status [--json]`, `apn stop`, `apn start`, `apn restart`, `apn logs [-f] [-n N]` operate the node-agent's OS service (systemd on Linux, launchd LaunchAgent on macOS) through a new `internal/service.Manager`.
  - `apn stop` is sticky: it stops **and disables** the service so it doesn't respawn on its own; `apn start` re-enables and starts it.
  - `apn status` reports local service state (installed/enabled/running/version) plus hub reachability and credential validity; exits 0 only when both are healthy.
- **`apn service install` / `apn service uninstall`** (#199) — install or remove the platform service directly from the binary, backed by embedded service templates (systemd user/system units, launchd plist).
- **Help system** (#199) — grouped top-level help (`apn`, `apn help`, `-h`/`--help`), per-command help (`apn help <command>`), and did-you-mean suggestions for unknown commands. `-h`/`--help` now gates every command, including `stop`/`start`/`restart`/`run`/`detect`/`version`/`service` — previously only the four commands with a `flag.FlagSet` (enroll, update, status, logs) recognized `-h`; the others executed the real action (e.g. `apn stop -h` used to actually stop the service).

### Changed

- **Installer thinning** (#199) — `install.sh` no longer inlines the systemd unit heredoc or the LaunchAgent plist heredoc, and no longer downloads `agentpod-node.service` for a system install; it downloads the binary, enrolls, then delegates service setup to `"$DEST_BIN" service install`. The `.service` release asset still ships (for direct consumers) — the installer just stops fetching it.
- **`apn update`'s restart delegates to `internal/service`** (#199) — the darwin/linux restart logic in selfupdate now goes through `service.NewManagerForRestart` instead of hand-built `launchctl`/`systemctl` argv.

---

## v0.1.12 — 2026-08-08

macOS installer rootless improvements and launchd-native update restart.

### Added

- **macOS rootless installer** (#193)
  - Installs are now per-user and rootless; sets up a persistent launchd LaunchAgent (`~/Library/LaunchAgents/dev.agentpod.node.plist`) with RunAtLoad and KeepAlive enabled.
  - Logs are written to `~/Library/Logs/agentpod-node.log`.
  - Sudo invocations re-exec as the invoking user, including when the installer is piped (`curl | sudo bash`); installations are idempotent (bootout then bootstrap, with `load -w` fallback).
  - KeepAlive enables one-click self-updates on macOS: the node exits on update, and launchd respawns it.

### Changed

- **Update restart on macOS** (#193)
  - `apn update` now restarts via `launchctl kickstart -k gui/<uid>/dev.agentpod.node` on macOS instead of failing with a systemctl hint; Linux behavior unchanged.

### Fixed

- **Piped-invocation re-exec** (#193)
  - The sudo/darwin re-exec added by this release used `bash "$0"`, which resolves to the literal string `"bash"` (not a file) under a piped `curl | bash` invocation — every re-exec case (macOS root-with-`SUDO_USER`, and the generic Linux sudo escalation) failed with `bash: bash: cannot execute binary file`. Re-exec now re-fetches a runnable copy of the installer when `$0` isn't a real file on disk, so the documented piped one-liners work as shipped. A non-root macOS invocation also no longer wastes a needless sudo re-exec before dropping back to a user install.

### Limitations

- LaunchAgent runs only while the user is logged in; sleep suspends the node until wake (shown offline until login/wake).

---

## [0.1.10] - 2026-08-07

Trustworthy fleet: reconciliation, self-healing enrollment, and release hardening.

### Fixed

- **Heartbeat reconciliation & gateway closure** (#47)
  - Epoch-guarded gateway close: nodes gracefully reconnect when hub restarts (no stale socket held).
  - Heartbeat re-register: nodes refresh their registration on each heartbeat, catching enrollment drift.
  - Boot reset: on startup, hub resets all online nodes to offline (sweeper catchup → reconnect).
  - 45-second heartbeat sweeper: expires silent online nodes (no heartbeat for 3 missed 15s beats) and detects stale registrations.
  
- **Self-healing re-enrollment** (#161)
  - Nodes detect stored credential rejection and automatically re-enroll the next time `enroll` runs (install/boot) — not mid-session.
  - `enroll --force` CLI flag: operators can force re-enrollment to recover from credential drift.
  - New `/public/nodes/credential-check` endpoint: a stateless credential probe (requires `Authorization: Bearer <nodeId>:<nodeSecret>`) used by the agent's self-healing enroll to check whether its stored credential is still valid before deciding to re-enroll.

### Changed

- **Authentication configuration tidying** (#149)
  - Config now reads `BETTER_AUTH_SECRET` and passes it explicitly to `betterAuth()` (was `SESSION_SECRET`, which Better Auth never read).

### Improved

- **Release pipeline hardening** (#188)
  - Release workflow now retries failed release-asset uploads up to 3 times (transient network flakes); arch builds themselves are not retried.
  - SHA256SUMS generation is decoupled from individual binary builds; SUMS and static assets still publish even if one arch hard-fails.

---

## [0.1.0] - 2026-06-29

First tagged release of AgentPod **as a fleet/facilities console for agent runtimes**. The OpenCode era is frozen at [`v0.0.4-opencode`](#legacy-v004-opencode).

### Added

**Attach-first node-agent**
- Go static binary that dials out to the hub over WSS — no inbound ports, works behind NAT/CGNAT.
- Auto-reconnect with exponential backoff; heartbeat-based health.
- Systemd service unit with hardening directives; install script (`scripts/install-node-agent.sh`) is idempotent.
- Enrollment flow: operator mints a token → `agentpod-node enroll --hub <url> --token <token>` → node registers and opens the tunnel.

**Observe capabilities (read-only)**
- **Inventory** — enumerate stations (runtimes) per node, recursively; advertise per-station capabilities.
- **Health** — status (running/stopped/crashed), CPU/RAM/disk, uptime, restart count, last activity.
- **Logs** — live-tail and history via the harness's native log source; streamed as framed messages over the node tunnel.
- **Filesystem (read)** — list, read, download; path-jailed to the station's workspace root.

**Write operations + durable terminal**
- **Filesystem write** — write, rename, delete, upload; all operations audited.
- **Terminal** — interactive PTY shell scoped to the station workspace; durable and reattachable (node-agent holds the PTY master with scrollback buffer; tmux/dtach used when available).
- **Config edit** — read/edit known config files with automatic backup, diff preview, and clobber detection before every write; restore from backup.
- **Lifecycle** — start / stop / restart per station (harness-appropriate: Hermes process tree, OpenClaw systemd unit, etc.).
- **Cleanup** — per-station disk usage summary; prune caches, rotate logs, reclaim space.

**Harness descriptors**
- Descriptors ship for: **Hermes**, **OpenClaw**, **Claude Code**, **Codex**, **OpenCode**.
- Each descriptor wraps the harness's native CLI/API for detection, enumeration, path resolution, lifecycle, and logs — no hub logic in descriptors.

**Remote / hosted + Matrix identity**
- Subdomain cookie sharing (`Domain=.<your-domain>; Secure`) so the console (`console.`) and hub (`hub.`) subdomains share a session — the console deploys on Cloudflare Pages, the hub on a VPS, both under one registrable domain.
- Hermes stations: Matrix ID display + `matrix.to` deep-link in the station detail panel.

**Provisioning**
- Pluggable `provisioner` driver interface.
- **Docker driver** (dogfood-proven): provisions containers from `agentpod-node:local` (plain) or `agentpod-node-opencode:local` (OpenCode preloaded, opencode-ai@0.5.5); container auto-enrolls via `PROVISIONING_HUB_URL`; station auto-adopted immediately.
- **Cloudflare Sandbox driver**: implemented; live-unverified (see Known Limitations).
- Destroy: stop + remove container; clean up hub registry.

**Unified responsive console**
- Fleet-first information architecture: node list → station tree → capability panels.
- **Cmd-K palette**: quick navigation and actions across the fleet.
- **Activity ticker**: live feed of recent operations (file writes, terminal sessions, lifecycle events, config edits) with jump-to-station.
- Connect banner for offline/disconnected nodes.
- Legacy routes (`/projects`, `/workflows`) removed.

**Hub**
- Bun + Hono backend with Drizzle + Postgres (pgvector dropped).
- Better Auth with Drizzle adapter; first user auto-becomes admin, signup closes after first user.
- Node gateway: WSS endpoint + in-process broker (`node → socket` map).
- Enrollment token minting + validation.
- Audit log for all write operations.
- Hub auto-runs Drizzle migrations on startup.

### Known Limitations

- **Single-operator only.** v0.1.0 ships one admin account (tenant-of-one). The data model carries owner/tenant scope and is multi-tenant-ready, but org management, tenant-isolation enforcement, signup/onboarding for others, and billing/quotas are **out of v0.1.0**. Multi-tenancy is a deliberate post-release effort targeting **v0.2.0**.
- **Cloudflare provisioning live-unverified.** The Cloudflare Sandbox driver is implemented but has not been smoke-tested against a live CF Sandbox environment. Use the Docker driver for production provisioning.
- **No repo-clone / credential-injection in provisioning.** Provisioned containers start with the node-agent and harness binary only; cloning a repo or injecting API keys into the container is not yet automated.
- **Phase 2 legacy cleanup pending.** Hub OpenCode backend, `docker/` images, `cloudflare/worker`, Tauri removal, and `config/` infrastructure retirement (#135–139) are deferred to a post-v0.1.0 milestone.

---

## Legacy: v0.0.4-opencode

The previous AgentPod product (OpenCode-based cross-platform sandbox application: Tauri desktop, Docker containers, OpenCode AI coding agent) is frozen at tag **`v0.0.4-opencode`**. That codebase is recoverable from git history; archived documentation is under [`docs/archive/`](./docs/archive/). No parallel maintenance is planned.
