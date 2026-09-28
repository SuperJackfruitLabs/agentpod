import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentCrypto, feedAgents, type CryptoRequest, type ShareReport } from "./crypto";

/**
 * The crypto state machine, driven the way the bridge drives it.
 *
 * These exercise the **real** `OlmMachine` — a native Rust binding generating
 * real keys — rather than a mock of it. A mocked crypto layer tests that the
 * mock agrees with itself, which for the one subsystem whose failures are
 * silent is worse than no test.
 *
 * There is no homeserver here. `send` is a spy that records what the machine
 * wanted to send and hands back the emptiest response the machine will accept,
 * which is enough to prove the plumbing without standing up Matrix.
 */

const DOMAIN = "id.agentpod.dev";
const ALICE = `@agent_alice:${DOMAIN}`;
const BOB = `@agent_bob:${DOMAIN}`;
const ROOM = "!room:id.agentpod.dev";

/**
 * The device the agent speaks through, created on the homeserver via MSC4190.
 *
 * A no-op here, and named rather than inlined so it is obvious that the real
 * one is a network call — an end-to-end run found that skipping it makes the
 * key upload fail with a bare 403 that never mentions devices.
 */
const deviceIdFor = async () => 'DEVICEFORTEST';
const uploadSigningKeys = async () => {};

const dirs: string[] = [];
async function storeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentpod-crypto-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

/**
 * A `send` that remembers what was asked and answers the emptiest thing the
 * machine will accept.
 *
 * Not `{}` — the first version of this returned that and every test failed
 * with `missing field one_time_key_counts`. The machine deserialises each
 * response into the strongly-typed reply for its request, so a keys/upload
 * needs its counts and a keys/query needs its (empty) device map. Carrying
 * the union of those fields answers every request type without this fixture
 * having to know which one it is holding — `RequestType` is an ambient const
 * enum and cannot be compared at runtime under `verbatimModuleSyntax`.
 */
function recorder() {
  const seen: CryptoRequest[] = [];
  return {
    seen,
    send: async (_userId: string, request: CryptoRequest) => {
      seen.push(request);
      return answer(request.body);
    },
  };
}

/**
 * The emptiest response the machine will accept — which is not `{}`, and not
 * a constant either. Both were tried and both looped forever.
 *
 * A keys/query answered with `device_keys: {}` means "answered for nobody",
 * so the machine asks again on the next pass, and the next. The flush loop's
 * stuck-guard caught it at ten passes, which is the only reason this is a
 * fixture bug rather than a hang. Echoing the queried users back — with no
 * devices, which is true of a user that has never logged in — is what closes
 * the question.
 *
 * Likewise `one_time_key_counts` must be non-zero: answering an upload with a
 * count of zero tells the machine its key pool is still empty, so it uploads
 * again.
 */
function answer(body: string): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    /* not every request body is JSON we care about */
  }
  const queried = parsed.device_keys as Record<string, unknown> | undefined;
  const deviceKeys: Record<string, unknown> = {};
  for (const user of Object.keys(queried ?? {})) deviceKeys[user] = {};

  return JSON.stringify({
    one_time_key_counts: { signed_curve25519: 50 },
    device_keys: deviceKeys,
    one_time_keys: {},
    failures: {},
  });
}

describe("agent crypto", () => {
  test("an agent's first transaction uploads its device keys", async () => {
    const { seen, send } = recorder();
    const crypto = createAgentCrypto({ storeDir: await storeDir(), domain: DOMAIN, send, deviceIdFor, uploadSigningKeys });

    await crypto.receive(ALICE, {});

    // A machine that has never run has no keys on the server, so the very
    // first thing it wants is to put them there. If this is empty the agent
    // is encrypting to nobody and nobody can encrypt to it.
    expect(seen.length).toBeGreaterThan(0);
    await crypto.close();
  });

  test("each agent gets its own store, because a shared one is a shared identity", async () => {
    const root = await storeDir();
    const { send } = recorder();
    const crypto = createAgentCrypto({ storeDir: root, domain: DOMAIN, send, deviceIdFor, uploadSigningKeys });

    await crypto.receive(ALICE, {});
    await crypto.receive(BOB, {});

    const entries = (await readdir(root)).sort();
    expect(entries).toEqual(["agent_alice", "agent_bob"]);
    await crypto.close();
  });

  test("an undecryptable event returns null rather than throwing", async () => {
    const { send } = recorder();
    const crypto = createAgentCrypto({ storeDir: await storeDir(), domain: DOMAIN, send, deviceIdFor, uploadSigningKeys });

    // Every agent sees these: events sent before it joined, or while it was
    // offline and the sender has since forgotten the session. Throwing would
    // fail the whole appservice transaction, which the homeserver then retries
    // forever — one unreadable message would wedge the bridge.
    const result = await crypto.decrypt(ALICE, `!room:${DOMAIN}`, {
      type: "m.room.encrypted",
      sender: BOB,
      event_id: "$nope",
      origin_server_ts: 1,
      content: {
        algorithm: "m.megolm.v1.aes-sha2",
        ciphertext: "not a real ciphertext",
        sender_key: "nope",
        session_id: "nope",
        device_id: "NOPE",
      },
    });

    expect(result).toBeNull();
    await crypto.close();
  });

  test("the same agent reuses one machine rather than rebuilding it", async () => {
    const { seen, send } = recorder();
    const crypto = createAgentCrypto({ storeDir: await storeDir(), domain: DOMAIN, send, deviceIdFor, uploadSigningKeys });

    await crypto.receive(ALICE, {});
    const afterFirst = seen.length;
    await crypto.receive(ALICE, {});

    // The second transaction has nothing new to say: keys are already
    // uploaded. A machine rebuilt per transaction would re-upload every time,
    // rotate the device on every message, and leave a trail of dead devices
    // that every other client must still encrypt to.
    expect(seen.length).toBe(afterFirst);
    await crypto.close();
  });
});

describe("narrowing a transaction to the agents in it", () => {
  const isOurs = (u: string) => u.startsWith("@agent_");

  /** A crypto double that records who was fed what. */
  function spy() {
    const fed: Array<{ userId: string; otk: Record<string, number>; fallback: string[] }> = [];
    return {
      fed,
      crypto: {
        receive: async (userId: string, tx: any) => {
          fed.push({ userId, otk: tx.otkCounts, fallback: tx.unusedFallbackKeys });
        },
        encrypt: async () => ({}),
        decrypt: async () => null,
        trackUsers: async () => {},
        close: () => {},
      },
    };
  }

  test("each agent is fed its OWN key counts, never another's", async () => {
    // The whole reason the per-user nesting is carried through. Feeding one
    // agent another's counts does not throw — it makes the first believe its
    // key pool is full when it is empty, so it stops replenishing and goes
    // quietly unreachable.
    const { fed, crypto } = spy();
    await feedAgents(
      crypto as any,
      {
        toDevice: [],
        deviceLists: { changed: [], left: [] },
        otkCounts: {
          [ALICE]: { AGENTPOD: { signed_curve25519: 5 } },
          [BOB]: { AGENTPOD: { signed_curve25519: 47 } },
        },
        unusedFallbackKeys: {},
      },
      isOurs,
    );

    const alice = fed.find((f) => f.userId === ALICE);
    const bob = fed.find((f) => f.userId === BOB);
    expect(alice?.otk).toEqual({ signed_curve25519: 5 });
    expect(bob?.otk).toEqual({ signed_curve25519: 47 });
  });

  test("an agent named only by a device-list change is still fed", async () => {
    // A machine never told that a peer rotated a device keeps encrypting to a
    // device that is gone, and the recipient can read none of it.
    const { fed, crypto } = spy();
    await feedAgents(
      crypto as any,
      {
        toDevice: [],
        deviceLists: { changed: [ALICE], left: [] },
        otkCounts: {},
        unusedFallbackKeys: {},
      },
      isOurs,
    );
    expect(fed.map((f) => f.userId)).toEqual([ALICE]);
  });

  test("users outside our namespace are not fed", async () => {
    const { fed, crypto } = spy();
    await feedAgents(
      crypto as any,
      {
        toDevice: [],
        deviceLists: { changed: ["@a-human:id.agentpod.dev"], left: [] },
        otkCounts: { "@another-human:id.agentpod.dev": { D: { signed_curve25519: 1 } } },
        unusedFallbackKeys: {},
      },
      isOurs,
    );
    expect(fed).toHaveLength(0);
  });

  test("fallback key types are merged across devices", async () => {
    const { fed, crypto } = spy();
    await feedAgents(
      crypto as any,
      {
        toDevice: [],
        deviceLists: { changed: [], left: [] },
        otkCounts: {},
        unusedFallbackKeys: { [ALICE]: { AGENTPOD: ["signed_curve25519"], OLD: ["signed_curve25519"] } },
      },
      isOurs,
    );
    expect(fed[0]?.fallback).toEqual(["signed_curve25519"]);
  });
});

/**
 * agentpod#604: the send path reported success for messages nobody could read.
 *
 * These pin the numbers that separate the indistinguishable causes. They do not
 * assert that sharing WORKS — the fixture answers `keys/query` for users with no
 * devices, so there is legitimately nothing to share with — they assert that what
 * happened is reported, which is the thing production could not tell anyone.
 */
describe("what an encrypted send did about keys", () => {
  test("reports the recipients, whether a session was claimed, and how many keys went out", async () => {
    const { seen, send } = recorder();
    const reports: ShareReport[] = [];
    const crypto = createAgentCrypto({
      storeDir: await storeDir(),
      domain: DOMAIN,
      send,
      deviceIdFor,
      uploadSigningKeys,
      onShare: (r) => reports.push(r),
    });

    await crypto.encrypt(ALICE, ROOM, [ALICE, BOB], "m.room.message", { body: "hello" });

    expect(reports).toHaveLength(1);
    expect(reports[0]!.roomId).toBe(ROOM);
    // Both recipients are counted, sender included: a count of 1 is the shape of a
    // message only its author can read.
    expect(reports[0]!.recipients).toBe(2);
    expect(typeof reports[0]!.claimedSessions).toBe("boolean");
    expect(reports[0]!.shares).toBeGreaterThanOrEqual(0);
    expect(seen.length).toBeGreaterThan(0);
  });

  test("a room holding only the sender reports one recipient", async () => {
    const reports: ShareReport[] = [];
    const crypto = createAgentCrypto({
      storeDir: await storeDir(),
      domain: DOMAIN,
      send: recorder().send,
      deviceIdFor,
      uploadSigningKeys,
      onShare: (r) => reports.push(r),
    });

    await crypto.encrypt(ALICE, ROOM, [ALICE], "m.room.message", { body: "alone" });

    expect(reports[0]!.recipients).toBe(1);
  });

  test("the hook is optional — nothing depends on it to encrypt", async () => {
    const crypto = createAgentCrypto({
      storeDir: await storeDir(),
      domain: DOMAIN,
      send: recorder().send,
      deviceIdFor,
      uploadSigningKeys,
    });
    const envelope = await crypto.encrypt(ALICE, ROOM, [ALICE, BOB], "m.room.message", { body: "x" });
    expect(envelope).toHaveProperty("ciphertext");
  });
});
