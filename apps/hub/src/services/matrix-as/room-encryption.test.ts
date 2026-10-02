import { beforeEach, describe, expect, test } from "bun:test";
import { createMatrixClient } from "./client";

/**
 * A station's room is created encrypted.
 *
 * It never was. `ensureRoom` sent `preset: "private_chat"` and nothing else, and the
 * `private_chat` preset does not imply encryption — it sets join rules and history
 * visibility only. Whether a room ended up encrypted therefore depended entirely on
 * whether some CLIENT in it turned encryption on afterwards.
 *
 * On 2026-10-02 that produced a clean and entirely accidental split on the live fleet:
 *
 *   original cast   10 rooms   ENCRYPTED   harness-mode agents, each with its own Matrix
 *                                          account and Hermes' matrix adapter, which
 *                                          enables encryption in its own room
 *   new cast        16 rooms   PLAINTEXT   `matrixIdentityMode: "bridge"` — the appservice
 *                                          speaks for them and no Matrix client ever joins,
 *                                          so nothing ever asked for encryption
 *
 * Those sixteen were about to handle repository contents, release artefacts and security
 * review in the clear. The bridge could encrypt the whole time (`AgentCrypto`, an
 * `OlmMachine` per agent, 37 device stores on disk); it simply had no encrypted room to
 * encrypt into.
 *
 * Encryption is one-way in Matrix: a room can be turned on and never off. So the right
 * place to decide is room creation, where the choice is still free.
 */

const AS_TOKEN = "test-as-token-encryption";
const HS = "http://homeserver.test";
const USER = "@agent_box_pi-x:id.agentpod.dev";
const ALIAS = "#agentpod_box_pi-x:id.agentpod.dev";

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];
let replies: Array<{ status: number; body: unknown }> = [];

function client() {
  return createMatrixClient({
    homeserverUrl: HS,
    asToken: AS_TOKEN,
    domain: "id.agentpod.dev",
    fetch: (async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(init.body as string) : null,
      });
      const reply = replies.shift() ?? { status: 200, body: { room_id: "!new:id.agentpod.dev" } };
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as unknown as typeof fetch,
  });
}

/** The `m.room.encryption` entry of a createRoom call's `initial_state`, or undefined. */
function encryptionState(body: Record<string, unknown> | null) {
  const initial = (body?.initial_state ?? []) as Array<Record<string, unknown>>;
  return initial.find((e) => e.type === "m.room.encryption");
}

beforeEach(() => {
  calls = [];
  replies = [];
});

describe("station rooms are created encrypted", () => {
  test("createRoom asks for megolm in initial_state", async () => {
    await client().ensureRoom(ALIAS, { creator: USER, name: "pi-x", topic: "pi @ box" });

    const create = calls.find((c) => c.url.includes("/createRoom"));
    expect(create).toBeDefined();

    const enc = encryptionState(create!.body);
    expect(enc).toBeDefined();
    expect(enc!.state_key).toBe("");
    expect((enc!.content as Record<string, unknown>).algorithm).toBe("m.megolm.v1.aes-sha2");
  });

  test("a DM is encrypted too", async () => {
    // The invited-human case is the one that carries real conversation, so it is the
    // last one that should be in the clear.
    await client().ensureRoom(ALIAS, {
      creator: USER,
      name: "pi-x",
      topic: "t",
      invite: "@rakesh:id.agentpod.dev",
      isDirect: true,
    });

    const create = calls.find((c) => c.url.includes("/createRoom"))!;
    expect(encryptionState(create.body)).toBeDefined();
    // and the DM semantics are untouched by the addition
    expect(create.body!.is_direct).toBe(true);
    expect(create.body!.invite).toEqual(["@rakesh:id.agentpod.dev"]);
  });

  test("the room created after reclaiming a stale alias is encrypted as well", async () => {
    // The retry path builds its own createRoom body. A fix applied to only the first
    // one would leave every rebuilt room in the clear — and a rebuild is exactly when
    // nobody is watching.
    replies = [
      { status: 400, body: { errcode: "M_ROOM_IN_USE" } }, // first create
      { status: 200, body: { room_id: "!old:id.agentpod.dev" } }, // directory lookup
      { status: 200, body: { joined_rooms: [] } }, // not a member — the alias is stale
      { status: 200, body: {} }, // delete the alias
      { status: 200, body: { room_id: "!fresh:id.agentpod.dev" } }, // second create
    ];

    await client().ensureRoom(ALIAS, { creator: USER, name: "pi-x", topic: "t" });

    const creates = calls.filter((c) => c.url.includes("/createRoom"));
    expect(creates.length).toBe(2);
    for (const c of creates) {
      expect(encryptionState(c.body)).toBeDefined();
    }
  });

  test("preset and alias are unchanged — this adds encryption, it does not restructure", async () => {
    await client().ensureRoom(ALIAS, { creator: USER, name: "pi-x", topic: "t" });

    const create = calls.find((c) => c.url.includes("/createRoom"))!;
    expect(create.body!.preset).toBe("private_chat");
    expect(create.body!.room_alias_name).toBe("agentpod_box_pi-x");
  });

  test("a SPACE is not encrypted — it is a container, not a conversation", async () => {
    // There are three createRoom bodies in this client and only two of them are rooms
    // people talk in. A blanket "add encryption to every createRoom" would have encrypted
    // the space too, which clients neither expect nor can read. This pins the distinction
    // so the next person adding a room type has to think about which kind it is.
    replies = [{ status: 200, body: { room_id: "!space:id.agentpod.dev" } }];

    await client().createSpace({ creator: USER, name: "Workspace" });

    const create = calls.find((c) => c.url.includes("/createRoom"))!;
    expect(create.body!.creation_content).toBeDefined();
    expect(encryptionState(create.body)).toBeUndefined();
  });
});
