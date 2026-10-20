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
