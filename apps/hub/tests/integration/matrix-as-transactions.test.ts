import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { rawSql } from "../../src/db/drizzle";
import { createMatrixAsRoutes } from "../../src/routes/matrix-as";

/**
 * The bridge's front door, and the three ways it goes wrong quietly.
 *
 * A homeserver pushes events here with no session and no user — only the
 * `hs_token` it was configured with. Everything that follows in the bridge
 * trusts what arrives, so this is the boundary that has to hold.
 */

const HS_TOKEN = "test-hs-token-transactions";
const AS_TOKEN = "test-as-token-transactions";
const DOMAIN = "id.agentpod.dev";

/** Events the route accepted and passed on, in order. */
let handled: Array<{ type: string; sender: string }> = [];

function app(opts: { onEvent?: (e: any) => Promise<void> } = {}) {
  return new Hono().route(
    "/_matrix/app/v1",
    createMatrixAsRoutes({
      hsToken: HS_TOKEN,
      domain: DOMAIN,
      onEvent:
        opts.onEvent ??
        (async (e: any) => {
          handled.push({ type: e.type, sender: e.sender });
        }),
    })
  );
}

/** Like `app()`, but also records the MSC3202 side-channels. */
function appWithCrypto(seen: any[]) {
  return new Hono().route(
    "/_matrix/app/v1",
    createMatrixAsRoutes({
      hsToken: HS_TOKEN,
      domain: DOMAIN,
      onEvent: async (e: any) => {
        handled.push({ type: e.type, sender: e.sender });
      },
      onCryptoTransaction: async (tx: any) => {
        seen.push(tx);
      },
    })
  );
}

function message(sender: string, body: string, roomId = "!r:id.agentpod.dev") {
  return {
    type: "m.room.message",
    sender,
    room_id: roomId,
    event_id: `$${Math.random().toString(36).slice(2)}`,
    origin_server_ts: 1,
    content: { msgtype: "m.text", body },
  };
}

function deliver(txnId: string, events: unknown[], token = HS_TOKEN) {
  return app().request(`/_matrix/app/v1/transactions/${txnId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  });
}

beforeAll(async () => {
  await ensurePgMigrations();
});

beforeEach(async () => {
  handled = [];
  await rawSql`DELETE FROM matrix_as_transactions WHERE txn_id LIKE 'test-txn-%'`;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM matrix_as_transactions WHERE txn_id LIKE 'test-txn-%'`;
  } catch {
    // cleanup only
  }
});

describe("PUT /_matrix/app/v1/transactions/:txnId", () => {
  test("refuses a transaction with no token at all", async () => {
    const res = await app().request("/_matrix/app/v1/transactions/test-txn-noauth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [message("@rakesh:id.agentpod.dev", "hi")] }),
    });

    expect(res.status).toBe(403);
    expect(handled).toHaveLength(0);
  });

  test("refuses the AS token, which points the other way", async () => {
    // as_token authenticates the bridge TO the homeserver; hs_token
    // authenticates the homeserver to the bridge. Swapping them is the mistake
    // a tired person makes at 1am, and accepting either would mean anything
    // holding the bridge's own credential could inject events.
    const res = await deliver("test-txn-wrongtoken", [message("@rakesh:id.agentpod.dev", "hi")], AS_TOKEN);

    expect(res.status).toBe(403);
    expect(handled).toHaveLength(0);
  });

  test("applies a transaction once, however many times it arrives", async () => {
    // The homeserver retries a transaction it did not see acknowledged. A
    // bridge that prompted twice for one message would double every
    // conversation, and the second answer would look like the agent talking to
    // itself.
    await deliver("test-txn-dup", [message("@rakesh:id.agentpod.dev", "hello")]);
    await deliver("test-txn-dup", [message("@rakesh:id.agentpod.dev", "hello")]);

    expect(handled).toHaveLength(1);
  });

  test("remembers what it applied across a restart", async () => {
    // Idempotency held in memory forgets exactly when the bridge is least
    // healthy — a crash mid-transaction is precisely when the homeserver
    // retries.
    await deliver("test-txn-durable", [message("@rakesh:id.agentpod.dev", "hello")]);

    const [row] = await rawSql`
      SELECT txn_id FROM matrix_as_transactions WHERE txn_id = 'test-txn-durable'`;
    expect(row).toBeTruthy();
  });

  test("drops events sent by our own users before anything else looks at them", async () => {
    // An Application Service is sent what its own users send. Answering those
    // is the loop that fills a database overnight.
    await deliver("test-txn-loop", [message("@agent_box_pi-x:id.agentpod.dev", "output")]);

    expect(handled).toHaveLength(0);
  });

  test("drops the appservice's own bot as well", async () => {
    await deliver("test-txn-loop2", [message("@ai-bridge:id.agentpod.dev", "housekeeping")]);
    expect(handled).toHaveLength(0);
  });

  test("still handles a human's events in a transaction that also contains ours", async () => {
    // The loop cut is per event, not per transaction — otherwise one echo would
    // silence a real message that arrived beside it.
    await deliver("test-txn-mixed", [
      message("@agent_box_pi-x:id.agentpod.dev", "echo"),
      message("@rakesh:id.agentpod.dev", "status?"),
    ]);

    expect(handled).toHaveLength(1);
    expect(handled[0]!.sender).toBe("@rakesh:id.agentpod.dev");
  });

  test("answers 200 with an empty object, which is what the homeserver expects", async () => {
    const res = await deliver("test-txn-empty", []);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  test("one poisoned event does not strand the rest behind it", async () => {
    // The homeserver retries the WHOLE transaction, so an event that always
    // throws would block every event after it, forever, on every retry.
    const seen: string[] = [];
    const a = app({
      onEvent: async (e: any) => {
        if (e.content?.body === "poison") throw new Error("handler exploded");
        seen.push(e.content?.body);
      },
    });

    const res = await a.request("/_matrix/app/v1/transactions/test-txn-poison", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HS_TOKEN}` },
      body: JSON.stringify({
        events: [message("@rakesh:id.agentpod.dev", "poison"), message("@rakesh:id.agentpod.dev", "second")],
      }),
    });

    expect(res.status).toBe(200);
    expect(seen).toEqual(["second"]);
  });

  test("ephemeral events are accepted and do not count as messages", async () => {
    // receive_ephemeral is on, so typing and receipts arrive in the same
    // transaction shape. They must not reach the message handler.
    const res = await app().request("/_matrix/app/v1/transactions/test-txn-eph", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HS_TOKEN}` },
      body: JSON.stringify({
        events: [],
        ephemeral: [{ type: "m.typing", room_id: "!r:id.agentpod.dev", content: { user_ids: [] } }],
      }),
    });

    expect(res.status).toBe(200);
    expect(handled).toHaveLength(0);
  });

  test("a bridge with no token configured refuses everything", async () => {
    // Fail closed: an unconfigured bridge that accepted anonymous pushes would
    // be an open injection point on a public path.
    const unconfigured = new Hono().route(
      "/_matrix/app/v1",
      createMatrixAsRoutes({ hsToken: "", domain: DOMAIN, onEvent: async () => {} })
    );

    const res = await unconfigured.request("/_matrix/app/v1/transactions/test-txn-unconf", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " },
      body: JSON.stringify({ events: [] }),
    });

    expect(res.status).toBe(403);
  });
});

describe("the encryption side-channels", () => {
  test("MSC3202 fields reach the crypto handler", async () => {
    const seen: any[] = [];
    await appWithCrypto(seen).request("/_matrix/app/v1/transactions/test-txn-crypto-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HS_TOKEN}` },
      body: JSON.stringify({
        events: [],
        to_device: [{ type: "m.room.key", sender: "@someone:id.agentpod.dev" }],
        device_lists: { changed: ["@a:id.agentpod.dev"], left: ["@b:id.agentpod.dev"] },
        // Keyed by user and then by device — MSC3202's shape, not /sync's.
        // An appservice holds many users where a client holds one.
        device_one_time_keys_count: {
          "@agent_x:id.agentpod.dev": { AGENTPOD: { signed_curve25519: 12 } },
        },
        device_unused_fallback_key_types: {
          "@agent_x:id.agentpod.dev": { AGENTPOD: ["signed_curve25519"] },
        },
      }),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].toDevice).toHaveLength(1);
    expect(seen[0].deviceLists).toEqual({
      changed: ["@a:id.agentpod.dev"],
      left: ["@b:id.agentpod.dev"],
    });
    expect(seen[0].otkCounts).toEqual({
      "@agent_x:id.agentpod.dev": { AGENTPOD: { signed_curve25519: 12 } },
    });
    expect(seen[0].unusedFallbackKeys).toEqual({
      "@agent_x:id.agentpod.dev": { AGENTPOD: ["signed_curve25519"] },
    });
  });

  test("a transaction with no encryption fields still reaches the handler, empty", async () => {
    // The homeserver omits these entirely when nothing changed, and an
    // appservice that only fed the machine when they were present would stop
    // flushing its outbox on a quiet server.
    const seen: any[] = [];
    await appWithCrypto(seen).request("/_matrix/app/v1/transactions/test-txn-crypto-2", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HS_TOKEN}` },
      body: JSON.stringify({ events: [] }),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].toDevice).toEqual([]);
    expect(seen[0].otkCounts).toEqual({});
  });

  test("a REPLAYED transaction still feeds the machine, though its events are skipped", async () => {
    // The design decision worth a test. A retry carries the *current* key
    // counts, and dropping them because the events were already applied would
    // leave the machine believing it holds keys the server has since handed
    // out — it would then stop replenishing and, eventually, be unable to
    // receive anything. Feeding olm the same to-device twice is survivable;
    // missing one is not.
    const seen: any[] = [];
    const body = JSON.stringify({
      events: [message("@someone:id.agentpod.dev", "hello")],
      device_one_time_keys_count: {
        "@agent_x:id.agentpod.dev": { AGENTPOD: { signed_curve25519: 3 } },
      },
    });
    const send = () =>
      appWithCrypto(seen).request("/_matrix/app/v1/transactions/test-txn-crypto-replay", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${HS_TOKEN}` },
        body,
      });

    await send();
    const afterFirst = handled.length;
    await send();

    expect(seen).toHaveLength(2);
    expect(handled.length).toBe(afterFirst);
  });
});
