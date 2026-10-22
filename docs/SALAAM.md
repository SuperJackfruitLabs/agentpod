# Salaam execution authority

**Description.** Opt-in node configuration and recovery behavior, checked against
`apps/node-agent/internal/salaam`, `apps/hub/src/services/salaam-authority.ts` and
`apps/hub/tests/integration/salaam-node-e2e.ts`. This integration is unreleased.

Salaam runs as a dedicated daemon on the enrolled node. The Hub binds an execution
to its Accounts organization and agent principal, current station occupant and
generation, workspace and work-run epoch. It checks fresh agent/owner authority;
provider credentials alone do not allow dispatch. The daemon enforces a 90-second
lease, fresh renewal after daemon restart and permanent revocation after stop.

Use a canonical absolute workspace and private daemon state **outside** that
workspace. Run the node and daemon as a trusted OS user. In an owner-only pins
file, set exactly `version: 1`, `organization_id`, `node_id`, `station_key` and
`workspace`. The station key is `salaam:` plus the first 16 hex characters of the
SHA-256 of the canonical workspace path. The enrolled node ID must match.

```sh
salaam service start --foreground --state /private/salaam-state --agentpod-config /private/salaam-pins.json
```

In the node's existing config, set `salaamBinary` to the absolute executable path,
`salaamStateDir` to the same private state directory and `salaamWorkspace` to the
pinned workspace. Discovery verifies live daemon health and advertises only
inventory, health and ACP. Adopt this station, map its tenant to the Accounts
organization, assign an agent principal and grant its owner dispatch authority.
The node admission credential stays local and never goes to the Hub or transcript.

Apply database migration `0101_salaam_execution_authority.sql` before running the
new Hub; update the daemon and node before opening the opted-in station. Missing
or old admission support denies execution. Back up Salaam state before upgrading:
its schema 20 cannot be opened by an older binary. This profile does not enable
station file access, terminal commands, coding tools, external runtimes or MCP.
Do not infer isolation from a malicious node administrator or other provisioners.

Closing ACP detaches. Ending a Hub session explicitly revokes its execution.
An ended transport can still show `execution.state: revocation_pending` and
`stopConfirmed: false`; replacements stay blocked until owned execution has
actually stopped and unknown operations are reconciled. A disconnected node never
counts as a confirmed stop. Reassignment advances the station's occupant generation,
including changing away and back to the same agent.

Interactive Hub/node recovery loads the saved Salaam session and inspects its
attempts without replaying prompts. A daemon restart requires fresh authority
before new execution. Board sessions after Hub restart are explicitly stopped and
reported interrupted; automatic board progression is a separate capability.
A network partition expires local authority even if the Hub cannot deliver stop.

For the local cross-product proof, follow the test database setup in
[TESTING.md](../TESTING.md), build Salaam, then run from `apps/hub`:

```sh
DATABASE_URL=postgres://agentpod:agentpod-dev-password@127.0.0.1:5434/agentpod \
SALAAM_REPO=/absolute/path/to/salaam \
bun tests/integration/salaam-node-e2e.ts
```

The script rejects non-test database destinations. It runs a real authenticated
local gateway, Go node, Salaam and pinned Pi with synthetic Accounts/board
ownership. It checks restart, lost acknowledgment, suspension, occupant changes,
stale epochs and real lease expiry. This is local conformance evidence, not a
production deployment or a live Accounts/Superpipeline acceptance run.

## Logical prompt recovery

Updated console clients save a logical prompt UUID before sending and retain it
through a lost echo or reload until the daemon's acceptance receipt arrives.
The Hub binds that UUID to immutable input in `acp_prompt_requests`; changed input
conflicts, and duplicate retries return the original attempt. Read access to saved
receipts does not require a new execution lease, but remains scoped to the owner.
The Doors editor facade forwards the same UUID in ACP `session/prompt` metadata
`_meta["salaam.dev/requestId"]` and returns `_meta["salaam.dev/promptReceipt"]`.
Editor history loads verify both the authenticated owner and selected station.
A completed retry returns its saved outcome without waiting for another turn;
an accepted retry waits for its own terminal receipt. The prompt ledger carries
the session tenant, enforced by a composite foreign key.
Older clients may omit the UUID; retries across separate sends then have no client
idempotency guarantee.

Install the updated Salaam adapter before the Hub: the two sides negotiate v1
prompt receipts and stable update IDs, and the new Hub refuses an older adapter
without them. Older Hubs do not request receipt notifications and keep their
existing ACP behavior. The Hub advertises `execution.promptReceipts: 1` to the
console. A newer console connected to an older Hub keeps its legacy prompt
behavior until that capability is present, so deployment order cannot leave it
waiting for unsupported acknowledgments. These flags grant no execution authority.

Apply migration `0102_salaam_prompt_recovery.sql` before the updated Hub. A prepared
instruction whose dispatch marker never committed can recover automatically after
fresh authority and loading the original session. An uncertain committed dispatch
is not automatically forwarded again. Reloaded ACP journal receipts reconcile
accepted/completed/interrupted attempts. Explicit retries preserve the same UUID;
interrupted execution requires continuation rather than silently starting over.

Stable source identities deduplicate repeated message parts during load. The Hub's
user prompt is retained once; materialized tool history can enrich the same tool
call. Transcript events and their session cursor commit together before publication.

## Reviewed daemon startup

For node-owned cold startup, plan an AgentPod host profile with canonical absolute
paths. This profile needs no Docker socket and enables no coding, filesystem,
terminal, MCP or external-runtime authority:

```json
{
  "mode": "agentpod",
  "state": "/private/salaam-state",
  "agentpod_config": "/private/salaam-pins.json"
}
```

Run the pinned Node executable explicitly when planning and starting the host:

```sh
/private/node/bin/node /private/salaam/bin/salaam.mjs host plan --config /private/host-config.json > /private/host.json
chmod 600 /private/host.json
/private/node/bin/node /private/salaam/bin/salaam.mjs host start --manifest /private/host.json
```

Set `salaamNodeBinary` and `salaamManifest` in the existing node config, alongside
`salaamBinary`, `salaamStateDir` and `salaamWorkspace`. The binary is the actual
canonical `bin/salaam.mjs` path, not a PATH alias or npm symlink; the Node path must
match the reviewed manifest. Discovery, ACP open and authority admission/renewal
validate that runtime. Existing separately supervised configurations remain
available by leaving the two new fields unset.

The owner-only manifest binds Node version/path, package source, build, CLI, pinned
Pi contents, provider route and authority pins. Runtime, pins, manifest and state
must remain outside the workspace. Startup uses OS-held locks and matching live
health; concurrent callers do not start duplicate hosts. The host supervises its
own daemon, stops on configuration drift and uses bounded restart/backoff. A
supervisor crash closes its daemon's IPC owner connection. Generate a systemd or
launchd unit with `host unit` when the OS service manager should own the host.

Back up private state before an upgrade, stop the old host deliberately, install
the reviewed runtime, and regenerate/review its manifest. A partial upgrade or
changed manifest is refused. Rollback requires compatible backed-up state and
matching runtime/manifest; restoring files never revives a revoked execution lease.
No package download, credential transfer or automatic version upgrade happens at
model admission. A disconnected node keeps the existing bounded authority lease;
new work requires fresh authority, and expiry still stops execution locally.

The real startup rehearsal uses the same local gateway and synthetic-plane scope:

```sh
DATABASE_URL=postgres://agentpod:agentpod-dev-password@127.0.0.1:5434/agentpod \
SALAAM_REPO=/absolute/path/to/salaam SALAAM_RUNTIME_REHEARSAL=1 \
bun tests/integration/salaam-node-e2e.ts
```

## Typed outcomes and cancellation

Install the updated daemon/ACP adapter before the Hub. The separate strict
`salaam.dev/executionFeatures` namespace negotiates version 1 failures,
cancellation receipts and tool semantics. The existing `salaam.dev/features`
receipt namespace stays unchanged. The updated Hub refuses a bound adapter that
lacks these features. Older Hubs receive RPC errors for partial-output failures
so they cannot mistake a token limit or refusal for a successful turn.

A successful model turn requires a verified `end_turn` outcome. Provider auth,
quota, rate-limit and other failures retain their typed cause and logical prompt,
local session and attempt IDs. Token limits and refusals retain their standard
ACP stop reasons even when the provider already emitted text. Provider credentials
and arbitrary response bodies are excluded from failure metadata. Legacy attempts
without a verified durable outcome remain unverified; reconnect never reruns them.

Cancellation records a stable UUID and its target logical prompt before sending.
A Hub crash before handoff retries that same cancellation; a daemon receipt
survives client, adapter and daemon restarts. A pre-dispatch cancellation fences
only that prompt, including a later delayed delivery. `requested` means the stop
is recorded, `confirmed` requires owned work to have settled and unresolved effects
to have been reconciled, and `unknown` keeps uncertain work blocked. An abort
acknowledgment or disconnected process alone cannot confirm cancellation. Ending
the session separately revokes its entire execution authority.

Clients opt into `salaam.dev/cancellationReceipt` updates. The receipt's session ID
is the daemon's local session ID, while the enclosing ACP notification uses the
Hub session ID. Do not substitute one identity for the other. Tool updates preserve
read/search/edit/delete/execute semantics where supported and use only actual
absolute guarded workspace locations. Immutable repository snapshots do not claim
editable source locations. This station profile still grants no coding or MCP tools.

No additional Hub database migration is required beyond the authority and prompt
ledgers above; cancellation intent and receipts use the durable session event
ledger. Back up daemon state before upgrading to schema 20. Downgrading requires a
compatible backup and reviewed runtime; old binaries refuse the newer schema.

## Opt-in managed tools and protected station work

The baseline profile above remains available. New private host references add
separate capabilities; upgrading binaries alone enables none of them. Install a
matching reviewed Salaam build and node before the Hub and apply migration
`0103_salaam_mcp_reconnect.sql`. Back up daemon state before schema 26; older
binaries require their compatible backup for rollback.

`mcp_config` admits a closed HTTP MCP catalog through the node-owned loopback
proxy. It binds the exact tool schemas, server endpoints, policy and limits.
Enable the proxy only for the adopted station ID in `mcpProxy.stations`. The node
persists credential generations and binds its fresh station tokens to the current
principal, organization, station occupant and execution root. A changed catalog
or assignment requires fresh admission; credentials never enter model context.
`toolkit_config` separately admits a pinned native Toolkit broker, its private
configuration and durable owner protocol. No PATH lookup or model-time plugin
installation is used. These references produce host schemas 3 and 4 respectively.

`station_config` selects host schema 5 and the explicit
`linux-systemd-station-v1` execution profile. It requires Linux, systemd, cgroups
v2, a root-owned controller, a verified reviewed runtime root and the pinned Go
file helper. Unsupported hosts fail readiness. The host must prove its actual
command boundary before the worker becomes ready. Ordinary station `fs.write`
and terminal capabilities remain absent; models use the managed station tool.

The helper uses beneath-root, no-symlink/no-mount-crossing resolution and excludes
credential/control paths. Progressive metadata handles up to 100,000 files without
loading the repository into model context. A proposed actual-root edit binds the
observed tree revision, prior file hash and complete new bytes to one durable
human permission. Stale edits are refused. Checks run as a dynamic user over a
filtered read-only snapshot with no network, provider credentials, node secret,
Docker socket or controller socket. Each check is bounded at 30 seconds, 512 MiB,
one CPU, 64 tasks and 64 KiB output; temporary storage is separately capped.

The daemon journals helper PID/start identities and exact systemd invocation and
cgroup ownership. Reconnect returns saved work; cancellation, revocation, lease
expiry and restart stop or fence owned resources. Unknown effects cannot become
success or justify replay. A verified check needs an actual zero exit status,
observed cleanup and an unchanged source revision. A model's final message or an
MCP protocol response alone is not evidence of completed product work.

The conformance workflow pins the exact companion Salaam revision and runs both
managed HTTP and protected systemd recovery against isolated test databases. The
protected run exercises 50,001 files, actual reviewed edits/checks, separate Hub
and node reconnects, daemon SIGKILL, revocation and a real 90-second lease expiry.
Accounts and product data in this default proof are synthetic. Live Claude and
scoped Library acceptance, a production rollout and released fleet acceptance
remain separate evidence.

For the closed profile schemas, limits and recovery details, consult the matching
Salaam build's `docs/contributor/managed-mcp.md` and
`docs/contributor/station-execution.md`. Runtime, credentials, private manifests
and journal state must stay outside the admitted source root.

Interactive clients explicitly request configured tools when creating the session:
`POST /api/stations/:id/acp/sessions` with `{"mode":"ask","mcpProxy":true}`.
The console offers “Use configured station tools” before a new session. Omitted
or false preserves the previous request behavior; this switch does not assign
a server, grant new tools, or bypass the private host profile and fresh authority.
A host requiring managed MCP refuses a session opened without its assignment.

## Reviewed host configuration

With the node operator's `configManagement` opt-in, every Salaam station also
reports four `report-only` settings, read from the daemon's `/v1/health`:
`salaam.provider.route` (`{provider, model, endpoint}`), `salaam.mcp.operator`
(`{digest, servers: [{name, transport, declarationDigest}]}`),
`salaam.agentpod.pins` (the pins file digest) and `salaam.tools.user` (when the
daemon reports one). No MCP command line, argument or environment, provider
connection setting or key is ever included. Declaring one of them
(`fleet config set`) makes the Console show whether the daemon matches it; the
node never writes them.


With the node operator's `configManagement` opt-in, a Salaam descriptor configured
with absolute private Node, CLI and manifest paths exposes the existing
`config.manage` interface. Its one registry entry, `salaam.host.manifest`, is the
complete output of `salaam host plan --config FILE`. It uses profile scope,
reconcilable policy and `restartToTakeEffect: true`. No bundle or provider secret
is carried by this declaration.

The existing Hub `config.observe`, `config.plan`, `config.apply` and
`config.inspect` verbs delegate to native CLI commands of the same suffix:
`salaam host config-observe|config-plan|config-apply|config-inspect --manifest FILE`.
Requests are bounded JSON on stdin using the existing config.manage v1 fields
(`stationKey`, `settings`, `operationId`, `want`, `planDigest`, as applicable).
Planning validates the intended manifest against fresh native `host plan`
results. Host identity (Node/repo, state, authority-pins path, workspace) cannot
be rebound through a setting. Package/source/runtime pins or referenced config
changes invalidate an unapplied review. The plan digest binds the prior manifest
bytes, target, station and displayed diff.

The native private journal lives beside the manifest under
`.agentpod/<manifest-name>.configuration/`. It retains request identity and
planned/applying/applied/conflict receipts. A request ID cannot be reused for a
different intent. Successful retries replay the saved receipt before fresh
runtime checks. Apply records `applying` before atomic replacement and fsync;
a retry can finish a write whose final receipt was interrupted. Unexpected
current bytes are preserved as a conflict. A rollback is another reviewed plan
validated against the currently installed package; it is never an automatic
restoration of old bytes.

Observation, polling and apply never start or restart a process. A configured
stopped installation remains detectable, with health reporting stopped. Explicit
ACP/session use retains the reviewed native host startup boundary; observing a
station does not activate its configuration. Apply obtains the existing startup,
supervisor and daemon OS ownership locks; a running owner or uncertain stop
refuses replacement. The caller must stop the supervised host before applying
and explicitly start or use the reviewed manifest afterwards. Health reads are passive.
An unchanged or missing PID cannot prove activation. Salaam instead forwards the
existing private daemon `host_manifest_digest` as optional station health
`configurationDigest`, only with healthy controls, a real positive PID, the
configured Node and a connected supervisor. The Hub requires that live digest to
match the canonical SHA-256 of the declared manifest before clearing
`awaiting-restart`; a file digest or saved apply receipt cannot do so. Other
harnesses retain their existing PID-based restart evidence. Older nodes omit the
optional field and remain conservatively awaiting restart.

The descriptor also implements the existing read-only `skills.inventory` path.
It reads the private session list and each session's explicit context admission,
never starts a process or scans unpublished files. Inventory is limited to 64
sessions, the station's exact configured workspace, an eight-second total probe
and bounded response bodies. Partial reads and excluded sessions make coverage
incomplete. Bundle digest, bundle manifest pin, entrypoint hash and skill identity
are validated separately. Loading is unknown until the current ready worker has
verified matching admitted bytes in an actual provider payload; stale resources
force loaded/eligible false. Aggregated reasons identify sessions. Presence,
admission and payload loading never establish skill exercise. TUI command inventory is available separately through the private
`GET /v1/command-inventory` endpoint. It describes the TUI registry and does not
establish ACP command announcements or skill loading.

### Operator recovery of an expired approval

With Hub restarted using literal `ENABLE_SUPERPIPELINE_BRIDGE=false`, an authenticated
human administrator can POST `/api/admin/bridge/agents/:key/salaam-settle` for an
exact enabled roster they own. The closed request is `{ "runId": "run_…",
"requestId": "<fresh settlement UUID>", "mode": "expired-approval",
"decisionRequestId": "<original expired decision UUID>" }`. Retain the same
settlement request UUID when retrying an unresolved response. `decisionRequestId`
is required only for this mode; existing modes reject it and an omitted mode still
means `never-dispatched`.

The route delegates to the existing terminal settlement service, which requires
exact stopped work ownership and an expired, unanswered decision with its producer
receipt and no daemon receipt. Recovery retains the original run and requests fresh
approval through the existing producer expiry path, without reusing an answer or
reviving revoked execution authority. Unresolved evidence refuses settlement.
The expiry receipt remains version 1. See
`packages/contract/src/salaam-operator-settlement.ts`,
`apps/hub/src/routes/admin-bridge-agents.ts`, and
`apps/hub/src/services/bridge/salaam-dispatch.ts`.
