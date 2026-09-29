# The bridge roster belongs in the database

**Status:** approved 2026-09-29. Supersedes `SUPERPIPELINE_BRIDGE_AGENTS` entirely.

## The problem

`hub.env` holds deployment facts: where Postgres is, which domain, which features are on.
`SUPERPIPELINE_BRIDGE_AGENTS` is not that. It is four *workspace* records — which agents exist,
which board each claims from, which station runs its work, which hub user owns its sessions, what
permission mode it runs in, and now two credentials each. That changes when the business changes,
not when the deployment changes.

It is also the only subsystem in AgentPod that works this way. Station adoption, git identities,
Matrix credentials, plugin operations, skills and transcription are all tenant-scoped Postgres rows
created by a human in the console. `matrix-credentials.ts` states the pattern outright: "A human
authorises a station; the node then redeems." The bridge roster skipped all of it.

What that costs, concretely:

- **Every roster change needs root on the hub host and a restart.** Adding an agent or rotating a
  token — the operation that happens most — is a shell session, where everything else is a button.
- **No `tenant_id`.** The hub's `tenantScope()` discipline, which refuses a tenant id that is not
  `fleet_<20 hex>`, stops at the bridge. The roster cannot be multi-tenant.
- **Plaintext credentials in a file**, now two per agent.
- **Nothing validates it against reality.** A `stationId` that no longer exists, or a `hubUserId`
  that does not own its station, surfaces only at claim time as "station not ready" — which is
  indistinguishable from a node that is merely offline.
- **No audit row** for who added an agent, or when.

Only `ENABLE_SUPERPIPELINE_BRIDGE` and `SUPERPIPELINE_BASE_URL` genuinely belong in env.

## Decisions

1. **`SUPERPIPELINE_BRIDGE_AGENTS` is removed outright** — no import path, no fallback. Two sources
   of truth is the problem being fixed, and a fallback that outlives the migration is a second
   source of truth with a longer name. The cost is a deliberate cutover; see below.
2. **Both credentials are encrypted at rest** with the existing `utils/encryption.ts`
   (AES-256-GCM, key from `ENCRYPTION_KEY`), following `transcription.api_key_encrypted`. They are
   never returned to a client.
3. **A console edit takes effect without a restart.** The loader becomes a reconciler.
4. **One slice**: table, API, loader and console together.

### On encrypting beside the key that decrypts it

`db/schema/service-keys.ts` already says this plainly about its own private JWK: Better Auth
encrypts with the app secret, "which lives in the same environment, on the same box, as this
database: the protection is thinner than it looks." The same is true here and is not claimed
otherwise. What this buys is not cryptographic: it is that the credential moves into the
tenant-scoped, audited, console-managed plane, and that a database dump is not *also* a file-system
dump. If it is ever not enough, the fix is a KMS, not a second local secret.

## Two fields that disappear

**`hubUserId`.** `getStation(userId, stationId)` filters on `stations.userId`, so a roster
`hubUserId` that is not the station's owner fails every ACP call as "Station not found". The field
can only ever hold one correct value, and holding it separately is exactly how a silent
misconfiguration happens. The table stores `station_id` and reads the user from the station.

`services/matrix-as/board-room.ts` — `matrixIdsForBoardHumans()`, the roster's second consumer and
"the only place that names a board's human at all" — improves for the same reason: a join to
`stations.user_id` rather than a hand-maintained copy.

**The env var itself.**

## Schema

```
bridge_agents
  tenant_id            text    not null  → tenants.id (restrict)
  key                  text    not null            -- lands in bridge_dispatches.agent_key
  board_id             text    not null            -- superpipeline's brd_…; theirs, so not an FK
  station_id           text    not null
  mode                 text    not null default 'full-auto'
  permission_wait_ms   integer                     -- null = the 30-minute default
  max_concurrency      integer
  profile_key          text
  token_encrypted      text    not null
  mcp_token_encrypted  text
  enabled              boolean not null default true
  created_by           text              → user.id (set null)
  created_at           timestamptz not null default now()
  updated_at           timestamptz not null default now()

  primary key (tenant_id, key)
  foreign key (station_id, tenant_id) → stations(id, tenant_id) on delete restrict
  check mode in ('ask', 'accept-edits', 'full-auto')
  check permission_wait_ms is null or permission_wait_ms > 0
  check max_concurrency   is null or max_concurrency   > 0
  check board_id ~ '^brd_[0-9a-f]{16}$'
```

The composite foreign key needs a new `uniqueIndex("stations_id_tenant_idx").on(id, tenantId)`,
which is precisely the precedent `nodes` already sets for `stations`' own
`(node_id, tenant_id)` key. Its argument carries over verbatim: a bridge agent in one tenant
pointing at a station in another becomes *unrepresentable* rather than merely unwritten.

`on delete restrict` rather than `cascade`: unadopting a station that still claims board work
should fail and say so, not silently destroy a row holding a credential a human pasted. `enabled`
exists so that stopping an agent does not require destroying that row either.

## The loader becomes a reconciler

`startSuperpipelineBridge()` stops building every loop once at boot. It becomes a supervisor on a
tick, in the shape `services/node-sweeper.ts` already establishes:

- a key in the table with no loop → start one
- a loop whose row vanished, or went `enabled = false` → `stop()` it
- a loop whose row's `updated_at` moved → `stop()` then start, so an edited token takes effect

**`stop()` is already drain-safe and needs no new machinery.** In `startAgentLoop`, the
`AbortController`'s signal is passed only to `sleep` — never to `opts.run()` — and the abort is
checked at the top of each cycle. `stop()` aborts the pending sleep and then awaits `done`, which
cannot resolve until the in-flight `runOnce` returns. A removed agent finishes the card it is
holding and then exits. This is a consequence of the existing deliberate choice not to bound a
cycle by a deadline ("a cycle deadline here would abandon real work mid-run"), and this design
depends on it: a test must pin it.

## Boot-time validation moves

`validateConfig()` runs at `index.ts:97`, **before** `initDatabase()` at line 100, so it cannot
reach the table. It keeps the flag and base-URL checks and drops the roster parse. It gains one:
`ENCRYPTION_KEY` is required when the bridge is enabled — an env fact, so still checkable there,
and without it every token in the table is unreadable.

The protection being given up is the original reason the check existed: "a bridge that silently
claimed nothing because its roster was malformed looks exactly like a quiet board." That returns as
a loud line at the first reconcile when the bridge is on and the roster is empty, naming the
console page to fix it at.

## API

Under `/api/bridge/agents`, admin-guarded, tenant-scoped like every other hub route:

| | |
|---|---|
| `GET /api/bridge/agents` | list. **No secrets** — `hasToken` and `hasMcpToken` booleans only |
| `POST /api/bridge/agents` | create |
| `PATCH /api/bridge/agents/:key` | update, including rotating either credential |
| `DELETE /api/bridge/agents/:key` | remove |

A write returns the row in list shape, so a client never has a path to read a credential back.

## Console

A Bridge section listing roster entries with their board, station, mode and live loop state, and a
form to add one. Station is a picker over adopted stations, not a typed id — the FK makes a wrong
one impossible to save, and the picker makes it impossible to try.

## Cutover

The env var is removed outright, so the order matters:

1. **Read the four plaintext tokens out of `/etc/agentpod/hub.env` first.** After the var is gone
   they are unrecoverable and all four agents need re-minting on superpipeline.
2. Deploy. The bridge is enabled with an empty roster: it claims nothing and says so every tick.
3. Enter the four agents in the console.
4. Loops start within one reconcile tick. Confirm with the `claiming` log line.
5. Delete `SUPERPIPELINE_BRIDGE_AGENTS` from `hub.env`.

## Also in the diff

- `loop.ts`'s halt message ends *"or remove this agent from SUPERPIPELINE_BRIDGE_AGENTS"* — a
  string that stops being true.
- `docs/DEPLOYMENT.md` § superpipeline bridge (the roster table and its field list) and
  `docs/OPERATING.md` § 8.
- `tests/helpers/scan-env-names.ts` covers env names named to operators in docs.

## Out of scope

Multi-tenant rostering beyond what the `tenant_id` column makes possible —
`resolveTenantForUser` still returns the bootstrap tenant for everyone. The column is the boundary
put in place ahead of the mapping, exactly as `bridge_dispatches` already does.
