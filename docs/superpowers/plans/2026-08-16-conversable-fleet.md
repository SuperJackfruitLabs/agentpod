# A Conversable Fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every station in the fleet is reachable from any Matrix client — the 18 whose harness has never spoken Matrix, and the 14 whose harness does, through one mechanism.

**Architecture:** Synapse moves to Postgres first, on its own. Then an Application Service inside the hub receives transactions at `/_matrix/app/v1/*`, owns a virtual `@agent_*` user and a room per station, maps inbound messages onto ACP sessions after checking the control pair, and streams the agent's output back by subscribing to the same in-process fan-out the console's WebSocket uses.

**Tech Stack:** Synapse 1.x + Postgres 16 (`LC_COLLATE=C`), Bun + Hono + Drizzle (hub), the Matrix Application Service API r0/v1, MSC2409 ephemeral events.

**Spec:** `docs/superpowers/specs/2026-08-16-matrix-application-service-design.md`

## Global Constraints

- **Homeserver:** `id.agentpod.dev` on `178.105.68.68`, private, federation disabled, nginx proxying `/_matrix` and `/_synapse` to `127.0.0.1:8008`.
- **Registration file:** `/etc/matrix-synapse/agents.yaml`, AS id `ai-agents`, `sender_localpart: ai-bridge`, users `@agent_.*` exclusive, aliases `#agentpod_.*` exclusive, `de.sorunome.msc2409.push_ephemeral: true`, `url: null` **until Task 9**.
- **Name derivation is a pure function** of `(nodeName, stationKey)`: lowercase, every character outside `[a-z0-9._=/-]` becomes `_`. User `@agent_<node>_<station>`, alias `#agentpod_<node>_<station>`. Never stored as a second source of truth.
- **`hs_token` authenticates every AS route**; a request without it is 403 and is never processed. The `as_token` is what the bridge sends *to* Synapse.
- **Drop every event sent by our own namespace** before any other handling.
- **Transactions are idempotent by `txnId`.**
- **Refusals are messages in the room**, never silence.
- Hub tests need `DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod"` and pgvector Postgres on :5434. Console tests need Node 22.
- **TDD:** failing test first, every task. Regression test for every bug fixed.

### Secrets, and where they are not

`as_token` and `hs_token` live in `/etc/matrix-synapse/agents.yaml` and in the hub's environment as `MATRIX_AS_TOKEN` / `MATRIX_HS_TOKEN`. **Neither goes in the repository, in a test fixture, or in a log line.** The bridge logs mxids and room ids, never tokens.

---

## Phase A — Synapse on Postgres (#329)

The migration plan is already written: `docs/superpowers/plans/2026-08-15-synapse-postgres-migration.md` on branch `docs/synapse-postgres-plan` (PR #329). Execute it as written. It is not restated here; these are the only additions this program makes to it.

### Task A1: Execute the migration, with the AS in mind

**Files:**
- Follow: `docs/superpowers/plans/2026-08-15-synapse-postgres-migration.md`
- Modify: `/etc/matrix-synapse/conf.d/database.yaml` (on the host)

- [ ] **Step 1: Take the backups the plan requires**

`sqlite3 .backup` of `homeserver.db`, plus `homeserver.signing.key` and `agents.yaml`, copied **off the box** and restored once into a scratch path to prove they open. The signing key cannot be regenerated: losing it loses the server's identity permanently.

> The host has **no `sqlite3` CLI** (checked 2026-08-16). Install it first — `apt-get install -y sqlite3` — or the plan's very first command fails.

- [ ] **Step 2: Create the database with C collation**

```sql
CREATE ROLE synapse_user LOGIN PASSWORD '<generated>';
CREATE DATABASE synapse ENCODING 'UTF8' LC_COLLATE='C' LC_CTYPE='C'
  template=template0 OWNER synapse_user;
```

`synapse_port_db` refuses to run without `C` collation, and fixing it afterwards means doing the migration again.

- [ ] **Step 3: Run the port with Synapse stopped**

Per the plan. 82 MB, ~19,400 events — minutes, not hours.

- [ ] **Step 4: Raise `cp_max` for the bridge**

The migration plan flags this as a follow-up; do it now rather than discovering it under load. In the Postgres stanza:

```yaml
database:
  name: psycopg2
  args:
    cp_min: 5
    cp_max: 15
```

An AS multiplies both connection demand and background work — the reason to leave SQLite in the first place.

- [ ] **Step 5: Verify, then keep the SQLite file**

`/health` on the hub is unrelated; verify Synapse itself: log in as an existing agent, read a room, send a message, and confirm `SELECT count(*) FROM events` in Postgres matches the SQLite count recorded in Step 1. Keep `homeserver.db` on disk, renamed `.migrated`, until Phase B is finished.

- [ ] **Step 6: Write the backup schedule that has never existed**

A nightly `pg_dump` of **both** databases (`agentpod`, `synapse`) plus the signing key, to somewhere off the box. The migration plan names this as the gap it does not close. Close it here — a homeserver with no backup is one disk away from every agent identity being unrecoverable.

- [ ] **Step 7: Document it**

`docs/OPERATING.md` has no homeserver section at all. Add one: where it runs, which database, how to restart it, where the registration lives, how to take and restore a backup.

- [ ] **Step 8: Commit**

```bash
git add docs/OPERATING.md
git commit -m "docs(ops): the homeserver, its database, and its backups"
```

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
    // acted as, and the failure is a 403 from Synapse at send time.
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

### Task 2: Record who owns a station's Matrix id

**Files:**
- Create: `apps/hub/src/db/drizzle-migrations/0044_matrix_id_source.sql`
- Modify: `apps/hub/src/db/drizzle-migrations/meta/_journal.json`
- Modify: `apps/hub/src/db/schema/stations.ts`
- Modify: `apps/hub/src/services/station-registry.ts` (the refresh path)
- Test: `apps/hub/tests/integration/matrix-id-source.test.ts`

**Interfaces:**
- Produces: `stations.matrixIdSource: "harness" | "bridge"`, default `"harness"`.

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
  await setMatrixIdBySource(STATION, "@agent_box_pi_x:id.agentpod.dev", "bridge");

  // What the node agent does on every detect.
  await refreshStationFromDetect(STATION, { matrixId: null });

  const row = await stationRow(STATION);
  expect(row.matrixId).toBe("@agent_box_pi_x:id.agentpod.dev");
  expect(row.matrixIdSource).toBe("bridge");
});

test("a harness-owned mxid is still refreshed by the node agent", async () => {
  // The existing behaviour must not regress: hermes reads its own identity off
  // the host, and a profile change has to land.
  await setMatrixIdBySource(STATION, "@old:id.agentpod.dev", "harness");

  await refreshStationFromDetect(STATION, { matrixId: "@new:id.agentpod.dev" });

  expect((await stationRow(STATION)).matrixId).toBe("@new:id.agentpod.dev");
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Write the migration**

```sql
-- 0044_matrix_id_source.sql
ALTER TABLE stations
  ADD COLUMN matrix_id_source text NOT NULL DEFAULT 'harness';

-- Every mxid that exists today was read off a host by the node agent.
-- The default is therefore correct for all 14 rows that have one, and the
-- bridge writes 'bridge' only where it takes ownership.
ALTER TABLE stations
  ADD CONSTRAINT stations_matrix_id_source_check
  CHECK (matrix_id_source IN ('harness', 'bridge'));
```

Add the journal entry. Classify the column in `db/tenant-scope.ts` if that file requires it for new columns.

- [ ] **Step 4: Guard the refresh path**

In `station-registry.ts`, the detect-refresh must not overwrite `matrix_id` when `matrix_id_source = 'bridge'`.

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

> The spec's routes are `PUT`, not `POST` — Synapse sends `PUT`. Mount **outside** the `/api/*` auth middleware: the caller is a homeserver with an `hs_token`, not a session.

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

test("records the station's mxid as bridge-owned", async () => {
  await provisionStation(KRISHNA);
  const row = await stationRow(KRISHNA);
  expect(row.matrixId).toBe("@agent_superchotu_openclaw_krishna:id.agentpod.dev");
  expect(row.matrixIdSource).toBe("bridge");
});

test("does not touch a harness-owned mxid", async () => {
  // Task 10 migrates those deliberately, per agent, with the harness's own
  // Matrix loop stopped first. Provisioning must not do it by accident.
  await provisionStation(ANALYST_ECHO);
  const row = await stationRow(ANALYST_ECHO);
  expect(row.matrixId).toBe("@analyst-echo:id.agentpod.dev");
  expect(row.matrixIdSource).toBe("harness");
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

### Task 9: Turn it on for the 18

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
url: "http://127.0.0.1:3001"    # was null
```

Then `systemctl restart matrix-synapse`. **This is the moment the bridge starts receiving traffic**; everything before it was inert.

- [ ] **Step 3: Verify with one station before the rest**

Pick `openclaw:krishna`. Join `#agentpod_superchotu_openclaw_krishna`, say hello, get an answer. Then check the refusal path: narrow your own grant to exclude openclaw, send again, and read the refusal **in the room**. Restore the grant.

- [ ] **Step 4: Provision the remaining 17**

- [ ] **Step 5: Document**

`docs/DEPLOYMENT.md` gains a Matrix bridge section: the five variables, the `url` flip, how to tell whether Synapse is delivering (its `appservice` logs), and the fact that `url: null` disables the whole thing without touching the hub.

- [ ] **Step 6: Commit**

```bash
git commit -m "docs(deploy): running the Matrix bridge"
```

---

### Task 10: Migrate the 14 hermes agents, one at a time

**Files:**
- Modify: `/etc/matrix-synapse/agents.yaml` (host — second user namespace)
- Create: `apps/hub/src/services/matrix-as/adopt-harness-mxid.ts`
- Test: `apps/hub/tests/integration/matrix-as-adopt.test.ts`

This is the riskiest task in the plan and the only one that touches something already working. **Nothing here is done in bulk.**

- [ ] **Step 1: Widen the namespace**

```yaml
  users:
    - regex: "@agent_.*"
      exclusive: true
    # The 14 hermes agents keep the addresses people already use. Listed
    # explicitly rather than by pattern: a broad regex here would claim human
    # accounts on this homeserver, and `exclusive: false` because these users
    # already exist and were not registered by us.
    - regex: "@(analyst-echo|artistic-lyra|buddhimaan|cleaner-cody|coder-kai|controller-casey|onboarding-olivia|optimizer-ollie|predictor-paul|project-manager-pete|research-ray|strategy-sam|threat-hunter-theo|writer-quill):id\\.agentpod\\.dev"
      exclusive: false
```

Restart Synapse. The bridge can now act as them; nothing yet does.

- [ ] **Step 2: Write the failing test for adoption**

```ts
test("adopting a harness mxid keeps the address and changes the owner", async () => {
  await adoptHarnessMxid(ANALYST_ECHO);

  const row = await stationRow(ANALYST_ECHO);
  expect(row.matrixId).toBe("@analyst-echo:id.agentpod.dev");   // unchanged
  expect(row.matrixIdSource).toBe("bridge");                     // changed
});

test("refuses to adopt while the harness's own Matrix loop is running", async () => {
  // Two answerers on one address is the failure this ordering exists to
  // prevent: the operator sees duplicate replies and cannot tell which is real.
  await hermesLoopIsRunning(ANALYST_ECHO);
  await expect(adoptHarnessMxid(ANALYST_ECHO)).rejects.toThrow(/still running|stop/i);
});

test("reverting is one row", async () => {
  await adoptHarnessMxid(ANALYST_ECHO);
  await revertHarnessMxid(ANALYST_ECHO);
  expect((await stationRow(ANALYST_ECHO)).matrixIdSource).toBe("harness");
});
```

- [ ] **Step 3: Implement, including the running-loop check**

How "is hermes's Matrix loop running for this agent" is determined is a host question — read it through the node agent's health/config surface. If it cannot be determined, **refuse**: an unverifiable precondition on the one task that can produce two answerers is not a precondition worth having.

- [ ] **Step 4: Cut over one agent**

`hermes:analyst-echo` first — it is the least critical. Stop its Matrix loop on molt-bot, adopt, send a message in its existing room, confirm exactly one answer arrives and it came through ACP (check `acp_events`).

- [ ] **Step 5: Wait a day, then do the remaining 13**

Not ceremony: the failure mode here is *a duplicate answer nobody notices*, and it needs a day of ordinary use to surface.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(hub): adopt a harness-owned Matrix identity into the bridge"
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

**Spec coverage.** Derived names (T1), ownership column (T2), transactions with auth/idempotency/loop-cut (T3), user and room queries (T4), acting as a station (T5), inbound with the control pair (T6), outbound streaming, typing and permissions (T7), provisioning all stations (T8), enabling for the 18 (T9), migrating the 14 (T10), operability (T11). The Postgres migration is Phase A and defers to the existing #329 plan.

**Deliberately not covered**, and named in the spec: kaambaan card/run/gate events (kaambaan#34 owns those schemas), E2EE, federation, and any node-agent change.

**Type consistency.** `bridgeUserId`/`bridgeAlias`/`isBridgeUser` (T1) are used with those signatures in T4, T5, T7 and T8; `matrixIdSource` is `"harness" | "bridge"` in T2, T8 and T10; `attachRoomToSession(sessionId, roomId, userId)` matches between T7's test and T8's provisioning.

**The two riskiest steps, both flagged in place:** flipping `url` (T9 Step 2), which is when a quiet system becomes a live one, and adopting hermes identities (T10), which is the only task that can produce two answerers on one address — hence one agent at a time, a day of real use, and a one-row rollback.
