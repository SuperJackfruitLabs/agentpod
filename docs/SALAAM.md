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
