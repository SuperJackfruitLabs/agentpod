# A Conversable Fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every station in the fleet is reachable from any Matrix client — the 18 whose harness has never spoken Matrix, and the 14 whose harness does, through one mechanism.

**Architecture:** The homeserver is replaced first — **tuwunel** (Apache-2.0) in place of Synapse (AGPLv3), starting empty. Then an Application Service inside the hub receives transactions at `/_matrix/app/v1/*`, owns a virtual user and a room per station, maps inbound messages onto ACP sessions after checking the control pair, and streams the agent's output back by subscribing to the same in-process fan-out the console's WebSocket uses.

**Tech Stack:** tuwunel 1.8.3 (RocksDB, embedded), Bun + Hono + Drizzle (hub), the Matrix Application Service API v1.

**Spec:** `docs/superpowers/specs/2026-08-16-matrix-application-service-design.md`
**Spike:** `docs/superpowers/specs/2026-08-16-tuwunel-appservice-spike-findings.md` — every AS feature below was verified against a running tuwunel before this plan was written.

## Global Constraints

- **Homeserver:** `id.agentpod.dev` on `178.105.68.68`, private, federation disabled, nginx proxying `/_matrix` to the homeserver's port. **tuwunel serves 6167 by default, not 8008** — the vhost changes with it.
- **Registration file:** a YAML file in tuwunel's `appservice_dir`, Synapse-shaped (the spike confirmed the existing file's namespaces load unchanged): AS id `ai-agents`, `sender_localpart: ai-bridge`, users `@agent_.*` exclusive, aliases `#agentpod_.*` exclusive, **`receive_ephemeral: true`** (tuwunel's name for what Synapse spelled `de.sorunome.msc2409.push_ephemeral`), and `url` **left unset until Task 9**.
- **Name derivation is a pure function** of `(nodeName, stationKey)`: lowercase, every character outside `[a-z0-9._=/-]` becomes `_`. User `@agent_<node>_<station>`, alias `#agentpod_<node>_<station>`. Never stored as a second source of truth. **All 32 stations, hermes included** — there is no exception list, because a name that omits the node breaks the rule the whole scheme rests on.
- **A station's identity has a mode**: `bridge` (the AS answers) or `harness` (the harness runs its own client). Exactly one answerer per address, always.
- **`hs_token` authenticates every AS route**; a request without it is 403 and is never processed. The `as_token` is what the bridge sends *to* the homeserver. The two point in opposite directions and swapping them fails as a 403 that reads like a permissions bug.
- **Drop every event sent by our own namespace** before any other handling.
- **Transactions are idempotent by `txnId`.**
- **Refusals are messages in the room**, never silence.
- Hub tests need `DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod"` and pgvector Postgres on :5434 — that is the **hub's** database and is unrelated to the homeserver, which has none. Console tests need Node 22.
- **A rejected registration is `M_EXCLUSIVE` with HTTP 400**, not 403 — the spec's code, and tuwunel's. Assert 400.
- **TDD:** failing test first, every task. Regression test for every bug fixed.

### Secrets, and where they are not

`as_token` and `hs_token` live in `/etc/tuwunel/appservices/agentpod.yaml` and in the hub's environment as `MATRIX_AS_TOKEN` / `MATRIX_HS_TOKEN`. **Neither goes in the repository, in a test fixture, or in a log line.** The bridge logs mxids and room ids, never tokens.

---

## Phase A — Replace the homeserver

**#329 is closed, not executed.** It existed because Synapse on SQLite has one
writer, no safe hot backup, and a migration that only gets harder. tuwunel is
RocksDB — embedded, concurrent, no separate database process — so every reason
for that plan is answered by not running SQLite at all.

**There is no migration path from Synapse.** The new homeserver starts empty.
What survives is every address, because an mxid is localpart + domain and both
are ours to recreate; what is lost is ~19,400 events of history, the room ids
and any media. Accepted deliberately: `acp_events` is the authoritative
transcript, Matrix carries a projection, and the bridge recreates every room.

### Task A1: Stand tuwunel up beside Synapse

**Files:**
- Create: `/etc/tuwunel/tuwunel.toml` (host)
- Create: `/etc/tuwunel/appservices/agentpod.yaml` (host)
- Create: `deploy/tuwunel/tuwunel.service` (repo — the unit, so it is not hand-rolled on the box)

- [ ] **Step 1: Take the backups anyway**

Synapse's `homeserver.db`, `homeserver.signing.key` and `agents.yaml`, copied off
the box. Not for the migration — there isn't one — but because Task A4 turns the
old server off, and a decision to discard history should be reversible for a
month.

> The host has **no `sqlite3` CLI** (checked 2026-08-16). `apt-get install -y sqlite3` first, or use `VACUUM INTO`.

- [ ] **Step 2: Write the config**

```toml
[global]
server_name = "id.agentpod.dev"
database_path = "/var/lib/tuwunel"
port = 6167
address = "127.0.0.1"
allow_registration = false          # the bridge registers agents; humans are made deliberately
allow_federation = false
appservice_dir = "/etc/tuwunel/appservices"
```

`allow_registration = false` from the first boot: the spike used open
registration and tuwunel warned about it on every start, correctly.

> **Two log lines that look like faults and are not**, both seen on the real
> deploy: `ERROR … loopback/localhost listening address … will NOT work` is a
> false positive under `--network host`, where 127.0.0.1 *is* the host; and
> `Error response from daemon: No such container: tuwunel` is the unit's
> `ExecStartPre=-docker rm -f`, which is why it carries a `-`.

- [ ] **Step 3: Write the registration with `url: null`**

> **Corrected on 2026-08-16 while executing this step.** Synapse tolerates the
> `url` key being absent; **tuwunel requires the field to be present** and aborts
> its whole appservice service with `missing field \`url\`` when it is not —
> which leaves the homeserver running and the appservice silently dead. `url:
> null` is accepted and means the same thing: registered, receiving nothing.

```yaml
id: ai-agents
as_token: <generate>
hs_token: <generate>
sender_localpart: ai-bridge
receive_ephemeral: true
rate_limited: false
namespaces:
  users:
    # One namespace for all 32. An earlier revision carried a second one listing
    # the 14 hermes localparts verbatim, to preserve addresses whose rooms and
    # history are being discarded anyway — fourteen hardcoded exceptions to the
    # rule that a name must include its node.
    - exclusive: true
      regex: "@agent_.*"
  aliases:
    - exclusive: true
      regex: "#agentpod_.*"
  rooms: []
```

**New tokens, not Synapse's.** The old ones were valid for a server that is
about to be switched off, and reusing a credential across a trust boundary
change is how a stale token outlives the thing it authenticated.

- [ ] **Step 4: Run it on a port nothing points at yet**

`systemctl enable --now tuwunel`, then confirm from the box:
`curl -s localhost:6167/_matrix/client/versions`. Synapse is still serving
`id.agentpod.dev`; nothing has moved.

- [ ] **Step 5: Commit the unit and the config shape**

```bash
git add deploy/tuwunel/
git commit -m "deploy: the tuwunel unit and its configuration"
```

### Task A2: Recreate the humans

- [ ] **Step 1: Register your own account on the new server**

With `allow_registration = false`, the admin console is the way in — and it needs
the database, which the running server holds. So: stop the service, run the
image once with `--execute "users create-user <name> <password>"`, start it again.

> **`create-user` prints the password to stdout**, so it lands in whatever
> terminal or transcript ran it. Either generate the password yourself and pass
> it explicitly (still echoed), or follow with `users reset-password` and keep
> only the second one. On this deploy the first password was echoed and was
> rotated for exactly that reason.

- [ ] **Step 2: Confirm the old client works against the new server**

supermessage, logged in against `id.agentpod.dev` — it will need a fresh login,
because the access token belonged to the other server.

### Task A3: Cut the domain over

- [ ] **Step 1: Stop Synapse**

`systemctl stop matrix-synapse && systemctl disable matrix-synapse`. Leave the
database on disk.

- [ ] **Step 2: Point nginx at 6167**

`deploy/nginx/agentpod.dev.conf`: `/\_matrix` → `127.0.0.1:6167`. The
`/_synapse` location is Synapse-specific and goes away. Keep the
`.well-known/matrix/*` files exactly as they are — the domain has not changed,
only what serves it.

- [ ] **Step 3: `nginx -t`, reload, and verify from off the box**

`curl https://id.agentpod.dev/_matrix/client/versions` should now be tuwunel's.

- [ ] **Step 4: Back up what there is to back up**

A nightly copy of `/var/lib/tuwunel` (stop-copy-start, or a RocksDB checkpoint)
plus `/etc/tuwunel/`, off the box. Synapse had **no backup schedule at all**;
this is the gap #329 named and never closed.

- [ ] **Step 5: Write the operator section**

`docs/OPERATING.md` has no homeserver section. Add one: what runs, where its data
is, how to restart it, where the registration lives, how to back it up and
restore it, and that `allow_registration` is off by design.

- [ ] **Step 6: Commit**

```bash
git add deploy/nginx/ docs/OPERATING.md
git commit -m "deploy: serve id.agentpod.dev from tuwunel"
```

### Task A4: Close #329

- [ ] **Step 1: Close it with the reason**

The Postgres migration is unnecessary: the homeserver it applied to is no longer
running. Link the spike findings so the reasoning survives.

---

## Phase B — The Application Service

### Task 1: Derive names, and prove the collision case

**Files:**
- Create: `apps/hub/src/services/matrix-as/names.ts`
- Test: `apps/hub/src/services/matrix-as/names.test.ts`

**Interfaces:**
- Produces: `bridgeUserId(nodeName, stationKey, domain)`, `bridgeAlias(nodeName, stationKey, domain)`, `localpartFor(nodeName, stationKey)`, `isBridgeUser(mxid, domain)`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { bridgeUserId, bridgeAlias, isBridgeUser } from "./names";

const D = "id.agentpod.dev";

/**
 * A Matrix name for a station.
 *
 * Derived, never stored: the same `(node, stationKey)` pair that identifies a
 * station in a grant. A mapping table would be a second source of truth for a
 * fact the fleet already knows.
 */
describe("bridge names", () => {
  test("name a node as well as a station", () => {
    // `opencode:c52ddf65` exists on two nodes in production right now. A name
    // that omitted the node would merge two different agents on two different
    // machines — the collision this suite has already undone once.
    const a = bridgeUserId("cloudchamber", "opencode:c52ddf65", D);
    const b = bridgeUserId("9247e5a88cfa", "opencode:c52ddf65", D);
    expect(a).not.toBe(b);
  });

  test("land inside the namespace the homeserver reserved", () => {
    // agents.yaml claims `@agent_.*` exclusive. A name outside it cannot be
    // acted as, and the failure is a 403 from the homeserver at send time.
    expect(bridgeUserId("molt-bot", "hermes:analyst-echo", D)).toBe(
      "@agent_molt-bot_hermes_analyst-echo:id.agentpod.dev"
    );
    expect(bridgeAlias("molt-bot", "hermes:analyst-echo", D)).toBe(
      "#agentpod_molt-bot_hermes_analyst-echo:id.agentpod.dev"
    );
  });

  test("replace characters an mxid localpart may not contain", () => {
    // `:` is the mxid separator; a station key is full of them.
    expect(bridgeUserId("box", "claude-code:48c62ea7", D)).toBe(
      "@agent_box_claude-code_48c62ea7:id.agentpod.dev"
    );
    expect(bridgeUserId("BOX", "Pi:59099BF1", D)).toBe(
      "@agent_box_pi_59099bf1:id.agentpod.dev"
    );
  });

  test("recognise our own users, which is how the loop is cut", () => {
    // An AS receives what its own users send. Answering those is an infinite
    // loop, so this predicate runs before anything else looks at an event.
    expect(isBridgeUser("@agent_box_pi_59099bf1:id.agentpod.dev", D)).toBe(true);
    expect(isBridgeUser("@rakesh:id.agentpod.dev", D)).toBe(false);
    // The AS's own sender_localpart is ours too.
    expect(isBridgeUser("@ai-bridge:id.agentpod.dev", D)).toBe(true);
    // Another server's user that merely looks like ours is not ours.
    expect(isBridgeUser("@agent_x:example.org", D)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" \
  bun test src/services/matrix-as/names.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * A station's Matrix names.
 *
 * Pure, and derived from the pair that already identifies a station in a grant
 * (`charter` → decisions/2026-08-15-a-grant-names-an-agent-per-plane.md). The
 * node is in the name because station keys repeat across the fleet.
 */

/** The localpart grammar Matrix allows, lowercased. Everything else becomes `_`. */
const ILLEGAL = /[^a-z0-9._=/-]/g;

export function localpartFor(nodeName: string, stationKey: string): string {
  const clean = (s: string) => s.toLowerCase().replace(ILLEGAL, "_");
  return `${clean(nodeName)}_${clean(stationKey)}`;
}

export function bridgeUserId(nodeName: string, stationKey: string, domain: string): string {
  return `@agent_${localpartFor(nodeName, stationKey)}:${domain}`;
}

export function bridgeAlias(nodeName: string, stationKey: string, domain: string): string {
  return `#agentpod_${localpartFor(nodeName, stationKey)}:${domain}`;
}

/**
 * Is this one of ours?
 *
 * The first question asked of every inbound event. An Application Service
 * receives what its own users send, and a bridge that answers those talks to
 * itself forever.
 */
export function isBridgeUser(mxid: string, domain: string): boolean {
  return mxid.startsWith("@agent_") || mxid === `@ai-bridge:${domain}`
    ? mxid.endsWith(`:${domain}`)
    : false;
}
```

- [ ] **Step 4: Run it and watch it pass**

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/matrix-as/
git commit -m "feat(hub): derive a station's Matrix names from its node and key"
```

---

### Task 2: Record which mode a station's identity is in

**Files:**
- Create: `apps/hub/src/db/drizzle-migrations/0044_matrix_identity_mode.sql`
- Modify: `apps/hub/src/db/drizzle-migrations/meta/_journal.json`
- Modify: `apps/hub/src/db/schema/stations.ts`
- Modify: `apps/hub/src/services/station-registry.ts` (the refresh path)
- Test: `apps/hub/tests/integration/matrix-id-source.test.ts`

**Interfaces:**
- Produces: `stations.matrixIdentityMode: "bridge" | "harness"`, default `"bridge"`.

> **A migration without a `meta/_journal.json` entry never runs.** This repo has been bitten; add the entry in the same commit.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Two writers, one column.
 *
 * `stations.matrix_id` is read off the host by the node agent from a harness
 * profile. The bridge writes it too, for stations whose harness has no Matrix
 * identity of its own. Without a recorded owner the node agent's next refresh
 * silently reverts the bridge — and the symptom is an agent that stops
 * answering in a room, with nothing anywhere saying why.
 */
test("a station refresh leaves a bridge-owned mxid alone", async () => {
  await setMatrixIdentity(STATION, "@agent_box_pi_x:id.agentpod.dev", "bridge");

  // What the node agent does on every detect.
  await refreshStationFromDetect(STATION, { matrixId: null });

  const row = await stationRow(STATION);
  expect(row.matrixId).toBe("@agent_box_pi_x:id.agentpod.dev");
  expect(row.matrixIdentityMode).toBe("bridge");
});

test("a harness-mode mxid is still refreshed by the node agent", async () => {
  // The existing behaviour must not regress: a harness that runs its own Matrix
  // client reads its identity off the host, and a profile change has to land.
  await setMatrixIdentity(STATION, "@old:id.agentpod.dev", "harness");

  await refreshStationFromDetect(STATION, { matrixId: "@new:id.agentpod.dev" });

  expect((await stationRow(STATION)).matrixId).toBe("@new:id.agentpod.dev");
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Write the migration**

```sql
-- 0044_matrix_identity_mode.sql
ALTER TABLE stations
  ADD COLUMN matrix_identity_mode text NOT NULL DEFAULT 'bridge';

-- 'bridge' is the safe default: the AS answers, and no credential exists
-- anywhere for that identity. A station only becomes 'harness' when somebody
-- deliberately issues it credentials (Task 8b), which is the act that could
-- otherwise produce two answerers on one address.
ALTER TABLE stations
  ADD CONSTRAINT stations_matrix_identity_mode_check
  CHECK (matrix_identity_mode IN ('bridge', 'harness'));
```

Add the journal entry. Classify the column in `db/tenant-scope.ts` if that file requires it for new columns.

- [ ] **Step 4: Guard the refresh path**

In `station-registry.ts`, the detect-refresh must not overwrite `matrix_id` when `matrix_identity_mode = 'bridge'`.

- [ ] **Step 5: Run the tests, then the full hub suite**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(hub): record whether a station's mxid comes from its harness or the bridge"
```

---

### Task 3: The transaction endpoint — authenticated, idempotent, loop-proof

**Files:**
- Create: `apps/hub/src/routes/matrix-as.ts`
- Create: `apps/hub/src/services/matrix-as/transactions.ts`
- Create: `apps/hub/src/db/drizzle-migrations/0045_matrix_as_txns.sql` (+ journal)
- Modify: `apps/hub/src/index.ts` (mount at `/_matrix/app/v1`)
- Test: `apps/hub/tests/integration/matrix-as-transactions.test.ts`

**Interfaces:**
- Consumes: `isBridgeUser` (Task 1).
- Produces: `PUT /_matrix/app/v1/transactions/:txnId` → `{}`; `applyTransaction(txnId, events)`.

> The spec's routes are `PUT`, not `POST` — the homeserver sends `PUT`, as the spike observed. Mount **outside** the `/api/*` auth middleware: the caller is a homeserver with an `hs_token`, not a session.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The three ways a bridge's front door goes wrong, all of them quiet.
 */
describe("PUT /_matrix/app/v1/transactions/:txnId", () => {
  test("refuses a transaction without the homeserver's token", async () => {
    const res = await app().request("/_matrix/app/v1/transactions/1", {
      method: "PUT",
      body: JSON.stringify({ events: [message("@rakesh:id.agentpod.dev", "hi")] }),
    });
    expect(res.status).toBe(403);
    expect(handled).toHaveLength(0);
  });

  test("refuses a transaction with the WRONG token", async () => {
    // Including the as_token, which is the token pointing the other way and is
    // the mistake a tired person makes at 1am.
    const res = await withToken(AS_TOKEN).request(/* … */);
    expect(res.status).toBe(403);
  });

  test("applies a transaction once, however many times it arrives", async () => {
    // Synapse retries. A bridge that prompted twice for one message would
    // double every conversation, and the second answer would look like the
    // agent talking to itself.
    await deliver("txn-1", [message("@rakesh:id.agentpod.dev", "hello")]);
    await deliver("txn-1", [message("@rakesh:id.agentpod.dev", "hello")]);

    expect(handled).toHaveLength(1);
  });

  test("drops events sent by our own users before anything else looks at them", async () => {
    // An AS receives what its own users send. This is the loop that fills a
    // database overnight.
    await deliver("txn-2", [message("@agent_box_pi_x:id.agentpod.dev", "output")]);
    expect(handled).toHaveLength(0);
  });

  test("answers 200 with an empty object, which is what the spec requires", async () => {
    const res = await deliver("txn-3", []);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  test("a handler that throws does not lose the rest of the transaction", async () => {
    // Synapse retries the WHOLE transaction; one poisoned event must not
    // strand the others behind it forever.
    await deliver("txn-4", [poison(), message("@rakesh:id.agentpod.dev", "second")]);
    expect(handled).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Migration for applied transactions**

```sql
-- 0045_matrix_as_txns.sql
CREATE TABLE matrix_as_transactions (
  txn_id     text PRIMARY KEY,
  applied_at timestamp NOT NULL DEFAULT now()
);
```

A table rather than memory: idempotency that forgets on restart is idempotency that fails exactly when the bridge is least healthy. Add the journal entry.

- [ ] **Step 4: Implement the route and `applyTransaction`**

Constant-time compare on `hs_token`; insert-or-skip on `txn_id`; drop `isBridgeUser` senders; handle each event inside its own try/catch; always answer `{}`.

- [ ] **Step 5: Run the tests, then the full hub suite**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(hub): receive Application Service transactions, once and only once"
```

---

### Task 4: Answer the homeserver's questions about our users and rooms

**Files:**
- Modify: `apps/hub/src/routes/matrix-as.ts`
- Test: `apps/hub/tests/integration/matrix-as-queries.test.ts`

**Interfaces:**
- Produces: `GET /_matrix/app/v1/users/:userId`, `GET /_matrix/app/v1/rooms/:alias`, `GET /_matrix/app/v1/ping`.

- [ ] **Step 1: Write the failing test**

```ts
test("claims a user that maps to a real station", async () => {
  // Synapse asks before it will let anyone talk to an unregistered user in our
  // namespace. Answering 200 is what makes the user exist.
  const res = await get(`/users/${encodeURIComponent(bridgeUserId("molt-bot", "hermes:analyst-echo", D))}`);
  expect(res.status).toBe(200);
});

test("disclaims a user in our namespace that maps to no station", async () => {
  // 404 rather than 200: claiming every conceivable name would let anyone
  // conjure an agent that does not exist by typing a room address.
  const res = await get("/users/%40agent_nowhere_nothing%3Aid.agentpod.dev");
  expect(res.status).toBe(404);
});

test("claims an alias that maps to a real station and creates the room", async () => {
  const res = await get(`/rooms/${encodeURIComponent(bridgeAlias("superchotu", "openclaw:krishna", D))}`);
  expect(res.status).toBe(200);
  expect(created.rooms).toHaveLength(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Both queries resolve the localpart back to `(node, stationKey)` and look for an adopted station. Unknown → 404.

- [ ] **Step 4: Run the tests**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(hub): answer which of our users and rooms exist"
```

---

### Task 5: A client for acting as a station

**Files:**
- Create: `apps/hub/src/services/matrix-as/client.ts`
- Test: `apps/hub/src/services/matrix-as/client.test.ts`

**Interfaces:**
- Produces: `ensureUser(localpart, displayName)`, `ensureRoom(alias, opts)`, `sendText(userId, roomId, body)`, `sendTyping(userId, roomId, on)`, `invite(roomId, mxid)`.

- [ ] **Step 1: Write the failing test**

```ts
test("acts as the station's user, not as the bridge", async () => {
  // ?user_id= is the whole mechanism. Without it every agent's message arrives
  // from @ai-bridge and the room becomes one voice pretending to be many.
  await sendText("@agent_box_pi_x:id.agentpod.dev", "!room:id.agentpod.dev", "hello");
  expect(lastUrl).toContain("user_id=%40agent_box_pi_x%3Aid.agentpod.dev");
});

test("carries the as_token, never the hs_token", async () => {
  // The two tokens point in opposite directions and swapping them fails with a
  // 403 that reads like a permissions bug.
  expect(lastHeaders.Authorization).toBe(`Bearer ${AS_TOKEN}`);
});

test("treats M_USER_IN_USE on register as success", async () => {
  // ensureUser runs on every message. The second call must be a no-op, not an
  // error that stops an agent answering.
  registerReplies(409, { errcode: "M_USER_IN_USE" });
  await expect(ensureUser("agent_box_pi_x", "pi")).resolves.toBeUndefined();
});

test("gives a message a transaction id so a retry cannot double-send", async () => {
  await sendText(USER, ROOM, "hello");
  expect(lastUrl).toMatch(/\/send\/m\.room\.message\/[^/]+$/);
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

`fetch` against `MATRIX_HOMESERVER_URL` (default `http://127.0.0.1:8008`), `Authorization: Bearer <as_token>`, `?user_id=` on every call, a UUID txn id per send, `M_USER_IN_USE` and `M_ROOM_IN_USE` treated as success.

- [ ] **Step 4: Run the tests**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(hub): a Matrix client that acts as a station"
```

---

### Task 6: A message becomes a prompt — with the control pair in front of it

**Files:**
- Create: `apps/hub/src/services/matrix-as/inbound.ts`
- Test: `apps/hub/tests/integration/matrix-as-inbound.test.ts`

**Interfaces:**
- Consumes: `resolveMatrixId`, `requireGrantReach`'s sibling `grantAllowsStation` + `getGrant`, `acpSessions.createSession/promptSession`, Task 5's client.
- Produces: `handleMessage(event, roomId)`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Who may talk to an agent is the control pair, unchanged.
 *
 * This is the reason the identity work came first: an inbound Matrix message
 * is an authorization question the suite can already answer.
 */
describe("an inbound message", () => {
  test("prompts the station when the sender's grant covers it", async () => {
    await setGrant(PRINCIPAL, { mayDispatch: ["agentpod:*/openclaw:*"], mayGrantReach: false });

    await handleMessage(message(PRINCIPAL_MXID, "status?"), ROOM_FOR_KRISHNA);

    expect(prompts).toHaveLength(1);
  });

  test("refuses in the room when the grant does not cover the station", async () => {
    // Silence would read as a broken agent, and the operator would go looking
    // in the wrong place — the console, the node, the harness.
    await setGrant(PRINCIPAL, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });

    await handleMessage(message(PRINCIPAL_MXID, "status?"), ROOM_FOR_KRISHNA);

    expect(prompts).toHaveLength(0);
    expect(sent.at(-1)!.body).toMatch(/not permitted|may not/i);
  });

  test("refuses a sender this hub cannot identify", async () => {
    await handleMessage(message("@stranger:id.agentpod.dev", "hi"), ROOM_FOR_KRISHNA);
    expect(prompts).toHaveLength(0);
    expect(sent.at(-1)!.body).toMatch(/do not recognise|not linked/i);
  });

  test("refuses an ambiguous mxid rather than guessing", async () => {
    // resolveMatrixId already fails closed here; the bridge must not "helpfully"
    // pick one. A human's words attributed to an agent is unrecoverable.
    await claimMxidAsBothStationAndPrincipal(AMBIGUOUS);
    await handleMessage(message(AMBIGUOUS, "hi"), ROOM_FOR_KRISHNA);
    expect(prompts).toHaveLength(0);
  });

  test("reuses the room's session instead of starting one per message", async () => {
    await setGrant(PRINCIPAL, { mayDispatch: ["agentpod:*/openclaw:*"], mayGrantReach: false });

    await handleMessage(message(PRINCIPAL_MXID, "first"), ROOM_FOR_KRISHNA);
    await handleMessage(message(PRINCIPAL_MXID, "second"), ROOM_FOR_KRISHNA);

    // A conversation is a conversation. One session per message would throw
    // away the agent's context between two consecutive sentences.
    expect(createdSessions).toHaveLength(1);
    expect(prompts).toHaveLength(2);
  });

  test("says so when the station is offline, rather than swallowing the message", async () => {
    await nodeGoesOffline();
    await handleMessage(message(PRINCIPAL_MXID, "hi"), ROOM_FOR_KRISHNA);
    expect(sent.at(-1)!.body).toMatch(/offline/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Resolve room → station (by alias, stored on a `matrix_rooms` mapping written in Task 4/7), resolve sender → principal, check the grant, create-or-reuse a session keyed by room, prompt.

- [ ] **Step 4: Run the tests, then the full hub suite**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(hub): a Matrix message is a prompt, if the sender may dispatch that agent"
```

---

### Task 7: The agent answers in the room

**Files:**
- Create: `apps/hub/src/services/matrix-as/outbound.ts`
- Test: `apps/hub/tests/integration/matrix-as-outbound.test.ts`

**Interfaces:**
- Consumes: the `acp-sessions` subscriber fan-out (the same one `station-acp.ts`'s WebSocket uses).
- Produces: `attachRoomToSession(sessionId, roomId, userId)`.

- [ ] **Step 1: Write the failing test**

```ts
test("streams the agent's text into the room as the station's user", async () => {
  attachRoomToSession(SESSION, ROOM, AGENT_USER);
  emit(SESSION, agentText("Working on it."));
  await settle();

  expect(sent.at(-1)).toMatchObject({ userId: AGENT_USER, roomId: ROOM, body: "Working on it." });
});

test("coalesces a stream of chunks into a message, not a message per token", async () => {
  // One Matrix event per token would be unreadable, would hit rate limits, and
  // would make a phone buzz forty times for one answer.
  attachRoomToSession(SESSION, ROOM, AGENT_USER);
  for (const c of ["Hel", "lo ", "there"]) emit(SESSION, agentText(c));
  await settle();

  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toBe("Hello there");
});

test("shows typing while a turn is in flight, and stops when it ends", async () => {
  // MSC2409 is already enabled in agents.yaml. Without this the room looks
  // dead during the ten seconds an agent is thinking.
  attachRoomToSession(SESSION, ROOM, AGENT_USER);
  emit(SESSION, turnStarted());
  expect(typing.at(-1)).toMatchObject({ on: true });

  emit(SESSION, turnEnded());
  await settle();
  expect(typing.at(-1)).toMatchObject({ on: false });
});

test("puts a permission request in the room as a question", async () => {
  // An agent blocked on a permission prompt with nobody watching the console is
  // an agent that has silently stopped.
  emit(SESSION, permissionRequest({ options: ["allow", "deny"] }));
  await settle();
  expect(sent.at(-1)!.body).toMatch(/permission|allow/i);
});

test("stops sending when the session ends, and detaches", async () => {
  attachRoomToSession(SESSION, ROOM, AGENT_USER);
  emit(SESSION, sessionEnded());
  emit(SESSION, agentText("late"));
  await settle();

  expect(sent.map((s) => s.body)).not.toContain("late");
  expect(subscriberCountFor(SESSION)).toBe(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Subscribe per session; buffer text and flush on turn end or after a short idle; typing on turn start/end; unsubscribe on session end. **Leak check:** `_subscriberCountForTest` already exists for exactly this.

- [ ] **Step 4: Run the tests, then the full hub suite**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(hub): the agent's answer arrives in the room, as the agent"
```

---

### Task 8: Provision every station's user and room

**Files:**
- Create: `apps/hub/src/services/matrix-as/provision.ts`
- Create: `apps/hub/src/db/drizzle-migrations/0046_matrix_rooms.sql` (+ journal)
- Test: `apps/hub/tests/integration/matrix-as-provision.test.ts`

**Interfaces:**
- Produces: `provisionStation(stationId)`, `provisionAll()`; table `matrix_rooms(room_id, station_id, alias)`.

- [ ] **Step 1: Write the failing test**

```ts
test("gives a station a user, a room and a readable name", async () => {
  await provisionStation(KRISHNA);

  expect(created.users).toContain("@agent_superchotu_openclaw_krishna:id.agentpod.dev");
  expect(created.rooms.at(-1)).toMatchObject({
    alias: "#agentpod_superchotu_openclaw_krishna:id.agentpod.dev",
  });
  // The display name is what a human sees in a member list — the station's
  // display name, not its mangled localpart.
  expect(created.displayNames.at(-1)).toBe("krishna (openclaw @ superchotu)");
});

test("is idempotent, because it runs on every adoption and every boot", async () => {
  await provisionStation(KRISHNA);
  await provisionStation(KRISHNA);
  expect(created.rooms).toHaveLength(1);
});

test("records the station's mxid, in bridge mode", async () => {
  await provisionStation(KRISHNA);
  const row = await stationRow(KRISHNA);
  expect(row.matrixId).toBe("@agent_superchotu_openclaw_krishna:id.agentpod.dev");
  expect(row.matrixIdentityMode).toBe("bridge");
});

test("provisions a hermes station exactly like every other", async () => {
  // No exception list. hermes gets the same derived name as openclaw, and the
  // display name carries the readability its old address used to.
  await provisionStation(ANALYST_ECHO);
  const row = await stationRow(ANALYST_ECHO);
  expect(row.matrixId).toBe("@agent_molt-bot_hermes_analyst-echo:id.agentpod.dev");
  expect(created.displayNames.at(-1)).toBe("analyst-echo (hermes @ molt-bot)");
});

test("leaves a harness-mode station's conversations alone", async () => {
  // The room is still provisioned — a harness client needs somewhere to talk —
  // but the bridge must not answer for a station that answers for itself.
  await setIdentityMode(ANALYST_ECHO, "harness");
  await provisionStation(ANALYST_ECHO);
  expect(subscribedSessionsFor(ANALYST_ECHO)).toHaveLength(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

`ensureUser` + display name, `ensureRoom` with the alias and a topic naming the station, invite the owning principal, upsert `matrix_rooms`, write `matrix_id`/`matrix_id_source` only when the source is not `harness`.

- [ ] **Step 4: Call it where stations arrive**

On adoption, and once at boot for anything missing. Gate the whole bridge on `ENABLE_MATRIX_BRIDGE === "true"` — the literal lowercase string, matching `ENABLE_KAAMBAAN_BRIDGE` and `ENFORCE_CONTROL_PAIR`.

- [ ] **Step 5: Run the tests, then the full hub suite**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(hub): every station gets a Matrix user and a room"
```

---

### Task 8b: Issue an identity, and optionally credentials, over the hub API

**Files:**
- Create: `apps/hub/src/routes/station-matrix.ts`
- Create: `apps/hub/src/services/matrix-as/credentials.ts`
- Test: `apps/hub/tests/integration/station-matrix-identity.test.ts`

**Interfaces:**
- Produces: `POST /api/stations/:id/matrix/identity` → `{ mxid, alias, roomId, mode }`; `POST /api/stations/:id/matrix/credentials` → `{ mxid, accessToken, deviceId }` and flips the station to `harness` mode.

This is what replaces the Synapse admin token that lives on molt-bot today. It is also what makes **dynamically created agents** work: a new station on any harness gets an identity by asking the hub, rather than by each harness learning to talk to a homeserver.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Registering an agent identity, without an admin credential on a node.
 *
 * Today `hermes-agents onboard` holds a homeserver admin token in a file on
 * molt-bot and can create, deactivate or take over ANY account on the
 * homeserver — including a human's. An Application Service needs no such rights
 * to register users inside its own namespace, so the ordinary path drops the
 * admin credential entirely and the privileged path moves behind the hub.
 */
describe("POST /api/stations/:id/matrix/identity", () => {
  test("provisions an identity with no admin credential involved", async () => {
    const res = await post(`/api/stations/${KRISHNA}/matrix/identity`);

    expect(res.status).toBe(200);
    expect((await res.json()).mxid).toBe("@agent_superchotu_openclaw_krishna:id.agentpod.dev");
    expect(adminCommandsRun).toHaveLength(0);
  });

  test("is idempotent — a re-run returns the same identity", async () => {
    const a = await (await post(`/api/stations/${KRISHNA}/matrix/identity`)).json();
    const b = await (await post(`/api/stations/${KRISHNA}/matrix/identity`)).json();
    expect(b).toEqual(a);
  });
});

describe("POST /api/stations/:id/matrix/credentials", () => {
  test("requires mayGrantReach, because a credential IS reach", async () => {
    // Handing an agent an access token is the definition of granting it reach
    // (charter → 2026-08-15-granting-reach-is-changing-an-agent). Dispatch
    // permission is not enough.
    await setGrant(PRINCIPAL, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });

    const res = await post(`/api/stations/${ANALYST_ECHO}/matrix/credentials`);
    expect(res.status).toBe(403);
  });

  test("mints a token and flips the station to harness mode", async () => {
    await setGrant(PRINCIPAL, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: true });

    const body = await (await post(`/api/stations/${ANALYST_ECHO}/matrix/credentials`)).json();

    expect(body.accessToken).toBeTruthy();
    expect((await stationRow(ANALYST_ECHO)).matrixIdentityMode).toBe("harness");
  });

  test("the bridge stops answering for that station the moment it does", async () => {
    // The two-answerer failure, prevented by construction rather than by
    // remembering to switch something off.
    await setGrant(PRINCIPAL, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: true });
    await post(`/api/stations/${ANALYST_ECHO}/matrix/credentials`);

    await handleMessage(message(PRINCIPAL_MXID, "hi"), ROOM_FOR_ANALYST_ECHO);
    expect(prompts).toHaveLength(0);
  });

  test("never logs the token it just issued", async () => {
    await setGrant(PRINCIPAL, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: true });
    const body = await (await post(`/api/stations/${ANALYST_ECHO}/matrix/credentials`)).json();
    expect(loggedLines.join("\n")).not.toContain(body.accessToken);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

`identity` calls Task 8's provisioning. `credentials` additionally: generate a password, run `users reset-password` (or `create-user`) through the homeserver's **admin room** as the hub's own admin account, then log in as the station's user to obtain a device token. Return it once; store nothing but the mode.

> **Simpler than planned, verified on the real server:** an Application Service
> registering a user through `POST /_matrix/client/v3/register` with
> `m.login.application_service` gets back an **`access_token` and `device_id`
> directly** — no admin command, no password, no login round-trip. The admin
> path (`users create-user` / `users reset-password`, console-only since tuwunel
> has no Synapse-shaped admin HTTP API) is only needed for accounts outside the
> AS namespace, i.e. humans.

- [ ] **Step 4: Run the tests, then the full hub suite**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(hub): register an agent's Matrix identity, and issue credentials only behind mayGrantReach"
```

---

### Task 8c: Port `hermes-agents onboard` onto the hub API

**Files:**
- Modify: `/root/maintenance/scripts/hermes-agents` on molt-bot (outside this repo)
- Modify: `docs/OPERATING.md`

Today's `cmd_onboard` does five Matrix things: checks the user through `/_synapse/admin/v2/users/…`, creates it with a generated password, logs in for a device token, creates a DM "home room", and writes `MATRIX_ACCESS_TOKEN` into the profile's env. **The first three break on tuwunel** — that admin API does not exist — and the fourth is what the bridge now does.

- [ ] **Step 1: Prove the failure before changing anything**

Run `hermes-agents onboard --homeserver <tuwunel> some-test-profile` against the new server and capture the error. A port that starts before the break is understood tends to preserve the wrong half.

- [ ] **Step 2: Replace the Matrix section with two calls**

```sh
# was: curl -X PUT $hs/_synapse/admin/v2/users/$uid  (admin token on this box)
# now: the hub owns identity, and the station is the thing that has one.
station_id=$(hub_api GET "/api/stations?node=$(hostname)&key=hermes:$profile" | jq -r '.[0].id')
creds=$(hub_api POST "/api/stations/$station_id/matrix/credentials")
```

The admin token file leaves molt-bot entirely.

- [ ] **Step 3: Handle the ordering, which has inverted**

Today the Matrix account exists before the agent runs. Now the **station must exist first** — the profile is created, the node agent detects it, the hub adopts it, and only then can it be given an identity. `onboard` waits for the station to appear (poll, with a timeout and a clear message naming what it is waiting for) rather than assuming.

- [ ] **Step 4: Retire the home-room creation**

The bridge provisions `#agentpod_<node>_hermes_<profile>` already. Keep marking it `m.direct` for the admin if that is what makes it land in a DM list.

- [ ] **Step 5: Onboard a throwaway agent end to end**

Create it, watch the station adopt, watch the identity provision, confirm the gateway starts and answers. Then remove it — including deactivating the Matrix user, which is now `users deactivate`.

- [ ] **Step 6: Document, and delete the admin token**

`docs/OPERATING.md`: how an agent is created now, and that no node holds homeserver admin rights any more. Then remove `/root/maintenance/.matrix-admin-token` from molt-bot and revoke it.

- [ ] **Step 7: Commit**

```bash
git commit -m "docs(ops): creating an agent no longer needs a homeserver admin token on a node"
```

---

### Task 9: Turn it on

**Files:**
- Modify: `/etc/matrix-synapse/agents.yaml` (host — set `url`)
- Modify: `/etc/agentpod/hub.env` (host)
- Modify: `deploy/nginx/hub.agentpod.dev.conf` if the AS is reached over the network rather than `127.0.0.1`
- Modify: `docs/DEPLOYMENT.md`

- [ ] **Step 1: Configure the hub**

```sh
ENABLE_MATRIX_BRIDGE=true          # literal lowercase "true"
MATRIX_HOMESERVER_URL=http://127.0.0.1:8008
MATRIX_SERVER_NAME=id.agentpod.dev
MATRIX_AS_TOKEN=<as_token from agents.yaml>
MATRIX_HS_TOKEN=<hs_token from agents.yaml>
```

- [ ] **Step 2: Point the registration at the hub**

```yaml
url: "http://127.0.0.1:3001"    # previously absent
```

Then `systemctl restart tuwunel`. **This is the moment the bridge starts receiving traffic**; everything before it was inert. tuwunel also accepts registrations by admin-room command without a restart — use the file, so the configuration is on disk where an operator can find it.

- [ ] **Step 3: Verify with one station before the rest**

Pick `openclaw:krishna`. Join `#agentpod_superchotu_openclaw_krishna`, say hello, get an answer. Then check the refusal path: narrow your own grant to exclude openclaw, send again, and read the refusal **in the room**. Restore the grant.

- [ ] **Step 4: Provision the remaining 31**

- [ ] **Step 5: Document**

`docs/DEPLOYMENT.md` gains a Matrix bridge section: the five variables, the `url` flip, how to tell whether tuwunel is delivering (its appservice log lines), and the fact that removing `url` disables the whole thing without touching the hub.

- [ ] **Step 6: Commit**

```bash
git commit -m "docs(deploy): running the Matrix bridge"
```

---

### Task 10: Decide, per hermes agent, who answers

The old plan retired hermes's Matrix client wholesale. With identity modes that
is no longer forced: hermes agents can keep their own clients under the same
`@agent_*` identity, or hand the conversation to the bridge. What must never
happen is both.

**Files:**
- Modify: hermes profile configuration on molt-bot (outside this repo)
- Modify: `docs/OPERATING.md`

- [ ] **Step 1: Start all 14 in `bridge` mode**

They arrive that way — it is the column default and Task 8 provisions them like
any other station. Their old credentials pointed at a homeserver that no longer
exists, so nothing of theirs can log in. Verify rather than assume: attempt a
login with a stored hermes token and confirm it fails.

- [ ] **Step 2: Live with it for a week**

The question "what did hermes's own Matrix client do that ACP does not" is
answered by absence, not by reading code. A week of ordinary use will surface
anything that mattered — rooms it joined itself, DMs with humans, presence.

- [ ] **Step 3: For anything that mattered, switch that agent to `harness` mode**

`POST /api/stations/:id/matrix/credentials` (Task 8b) issues the token and flips
the mode; the bridge stops answering for it in the same write. Per agent, and
only where the absence was felt.

- [ ] **Step 4: Write down what each mode costs**

In `docs/OPERATING.md`: a `bridge` agent gains the control pair, an `acp_events`
transcript and no credential on any host; a `harness` agent gains its own client
and keeps its own Matrix behaviour, at the cost of a token existing and the
control pair not seeing those conversations.

- [ ] **Step 5: Commit**

```bash
git add docs/OPERATING.md
git commit -m "docs(ops): who answers for an agent, and what each mode costs"
```

---

### Task 11: Operate it

**Files:**
- Modify: `docs/OPERATING.md`
- Create: `apps/hub/src/services/matrix-as/health.ts`
- Test: `apps/hub/tests/integration/matrix-as-health.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("reports a bridge that is configured but receiving nothing", async () => {
  // The exact shape of the pre-existing bug: url: null meant a perfectly
  // healthy AS that had never been sent a single event, and nothing said so.
  await noTransactionsFor(2 * 60 * 60 * 1000);
  const h = await bridgeHealth();
  expect(h.status).toBe("silent");
  expect(h.reason).toMatch(/no transaction/i);
});
```

- [ ] **Step 2: Implement, and surface it**

Last-transaction timestamp, rooms provisioned, sessions attached. Boot warning when `ENABLE_MATRIX_BRIDGE` is true and the tokens are missing — the same shape as the bridge and control-pair warnings.

- [ ] **Step 3: Write the operator section**

`docs/OPERATING.md`: what the bridge is, the room naming scheme, how to find an agent's room, what a refusal in a room means, how to turn it off (`url: null`, one restart), and how to read Synapse's appservice logs.

- [ ] **Step 4: Commit**

```bash
git commit -m "docs(ops): the Matrix bridge, and how to tell it is working"
```

---

## Self-review

**Spec coverage.** Derived names, uniform across all 32 (T1), identity mode (T2), transactions with auth/idempotency/loop-cut (T3), user and room queries (T4), acting as a station (T5), inbound with the control pair (T6), outbound streaming, typing and permissions (T7), provisioning (T8), identity and credential registration over the hub API (T8b), porting `hermes-agents onboard` off the Synapse admin token (T8c), going live (T9), deciding who answers per hermes agent (T10), operability (T11). Phase A replaces the homeserver rather than migrating its database, and closes #329.

**Deliberately not covered**, and named in the spec: kaambaan card/run/gate events (kaambaan#34 owns those schemas), E2EE, federation, and any node-agent change.

**Type consistency.** `bridgeUserId`/`bridgeAlias`/`isBridgeUser` (T1) are used with those signatures in T4, T5, T7 and T8; `matrixIdSource` is `"harness" | "bridge"` in T2, T8 and T10; `attachRoomToSession(sessionId, roomId, userId)` matches between T7's test and T8's provisioning.

**The riskiest steps, flagged in place:** cutting nginx over (A3), after which the old server is unreachable and its history is only in a backup; and flipping `url` (T9 Step 2), when a quiet system becomes a live one. The original plan's most dangerous task — adopting hermes's identities while its own Matrix loop could still answer — **no longer exists**, because a fresh homeserver never has two answerers for one address.
