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
its schema 19 cannot be opened by an older binary. This profile does not enable
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
