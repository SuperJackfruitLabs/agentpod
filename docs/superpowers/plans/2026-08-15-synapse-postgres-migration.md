# Migrating id.agentpod.dev from SQLite to PostgreSQL

**Status:** Plan, 2026-08-15. Not executed. Written to be sat on.
**Host:** `178.105.68.68` — the same box as the hub, its Postgres, and nginx.
**Audience:** whoever runs the migration, including a version of us in a month
who has forgotten the details.

## Why

Synapse runs on **SQLite** (`/var/lib/matrix-synapse/homeserver.db`, 79 MB,
19,400 events, ~1,000 events/week and rising). Synapse's own documentation is
direct about this: SQLite is for small or test deployments, and Postgres is the
supported production backend. The specific costs, in the order they will bite:

1. **One writer.** SQLite serialises writes. Synapse's background jobs (state
   resolution, receipts, device lists) already contend with live traffic, and
   an Application Service multiplies both — virtual users, ephemeral events over
   MSC2409, and a bridge that reacts to every message.
2. **No safe hot backup.** Copying a live SQLite file can capture a torn write.
   The correct online method is `sqlite3 .backup` or the backup API, which is
   not what a naive `cp` in a cron job does.
3. **Migration only gets harder.** `synapse_port_db` runs in time proportional
   to the database. 79 MB is an evening; a year of chat is not.

## What must be true before we start

**These are prerequisites, not steps.** The migration is reversible only because
of the first one.

- [ ] **A verified backup of `homeserver.db`**, taken with `sqlite3 .backup` or
      `VACUUM INTO`, restored once into a scratch path and opened, so we know the
      copy is real. A backup nobody has restored is a hope.
- [ ] **A copy of `/etc/matrix-synapse/homeserver.signing.key`**, stored off the
      box. Losing this loses the server's identity permanently — every event
      ever signed by it, and any future federation, depends on that key. It
      cannot be regenerated.
- [ ] **A copy of `/etc/matrix-synapse/agents.yaml`** and the admin token file
      referenced by `hermes-agents` (`/root/maintenance/.matrix-admin-token` on
      molt-bot). Both are credentials; neither is in any repository.
- [ ] **A maintenance window.** Synapse must be **stopped** for the final port
      run, or the copy is inconsistent. Every agent gateway loses its connection
      for the duration and reconnects afterwards; nothing else in the fleet
      depends on Matrix today, so blast radius is the agents' own chat.

## Decisions to make first

**1. Which Postgres?** The hub already runs one on this host. Two options:

   - *Same instance, separate database and role* — one thing to back up, one
     thing to tune, and the hub's connection pool and Synapse's compete for the
     same shared buffers.
   - *Separate instance on a different port* — isolation, and a second thing to
     operate.

   **Recommendation: same instance, separate database `synapse` and role
   `synapse_user`.** At this size the isolation is not worth a second daemon,
   and a single `pg_dump` covering both is a real operational simplification.
   Revisit if Matrix traffic grows past the hub's.

**2. Collation.** Synapse requires the database be created with
   `LC_COLLATE='C'` and `LC_CTYPE='C'`. This is not advisory — `synapse_port_db`
   refuses to run otherwise, and getting it wrong after the fact means doing the
   migration again. It is the single most common way this task is failed.

**3. Do we take the opportunity to move the AS registration?** No. One change at
   a time. The namespace decision (see the fleet-conversation thread) is
   independent and should not ride along with a storage migration.

## The migration

Times are for a 79 MB database on this host; expect the port itself to be
minutes, not hours.

### 1. Backup (with Synapse still running)

```sh
systemctl status matrix-synapse                       # note it is running
sqlite3 /var/lib/matrix-synapse/homeserver.db \
  ".backup '/root/synapse-backup-$(date +%F).db'"
cp /etc/matrix-synapse/homeserver.signing.key /root/
cp /etc/matrix-synapse/agents.yaml /root/
# Prove the backup opens and has the rows we expect:
sqlite3 /root/synapse-backup-*.db "select count(*) from events;"
```

Copy all three off the box before continuing.

### 2. Create the database

```sql
CREATE ROLE synapse_user WITH LOGIN PASSWORD '<generated>';
CREATE DATABASE synapse
  ENCODING 'UTF8'
  LC_COLLATE='C'
  LC_CTYPE='C'
  template=template0
  OWNER synapse_user;
```

Verify before going further — this is the step that cannot be undone cheaply:

```sql
SELECT datname, datcollate, datctype FROM pg_database WHERE datname='synapse';
-- both must read exactly: C
```

### 3. Point a *copy* of the config at Postgres

Write the new `database:` block into `/etc/matrix-synapse/conf.d/database.yaml`
(a new file — leave `homeserver.yaml`'s block in place until the cutover, so
rollback is deleting one file):

```yaml
database:
  name: psycopg2
  txn_limit: 10000
  args:
    user: synapse_user
    password: <generated>
    database: synapse
    host: 127.0.0.1
    port: 5432
    cp_min: 5
    cp_max: 10
```

### 4. Stop Synapse and run the port

```sh
systemctl stop matrix-synapse
/opt/venvs/matrix-synapse/bin/synapse_port_db \
  --sqlite-database /var/lib/matrix-synapse/homeserver.db \
  --postgres-config /etc/matrix-synapse/conf.d/database.yaml
```

`synapse_port_db` is resumable: if it fails partway, fix the cause and run it
again. It will not silently produce a half-populated database.

### 5. Cut over and verify

Remove the old `database:` block from `homeserver.yaml`, then:

```sh
systemctl start matrix-synapse
journalctl -u matrix-synapse -f          # watch for a clean startup
```

Verification, in order of what actually proves something:

```sh
# The server answers at all
curl -s -o /dev/null -w '%{http_code}\n' https://id.agentpod.dev/_matrix/client/versions

# The data arrived — compare against the numbers taken before the port
psql -U synapse_user -d synapse -c 'select count(*) from events;'    # expect ~19,400+
psql -U synapse_user -d synapse -c 'select count(*) from users;'     # expect 15

# An agent can still authenticate and see its room. This is the real test:
#   from molt-bot, restart one gateway and confirm it reconnects and can post.
```

**Do not delete `homeserver.db`.** Rename it to `homeserver.db.premigration` and
leave it for a fortnight.

### 6. Rollback

Stop Synapse, delete `/etc/matrix-synapse/conf.d/database.yaml`, restore the
`database:` block in `homeserver.yaml`, start Synapse. The SQLite file is
untouched by the port — it is read-only input — so rollback is a config change,
not a restore. This is why step 5 does not delete anything.

## After

- [ ] **A real backup schedule.** There is none today: no copy of
      `homeserver.db` or the signing key exists anywhere on the host. Postgres
      makes this ordinary — `pg_dump` of both `agentpod` and `synapse` on a
      timer, off-box.
- [ ] Fold the homeserver into `docs/OPERATING.md`, which does not mention it at
      all today. An operator reading our runbooks would not know it exists.
- [ ] Revisit `cp_max` if the Application Service lands; a bridge changes the
      connection profile considerably.

## What this does not fix

Synapse still shares one 75 GB host with the hub, the hub's Postgres and nginx.
That is a separate conversation about blast radius, and this migration neither
helps nor hurts it.
