import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { withEncryption } from "./crypto-send";

/**
 * Sending into an encrypted room goes through this decorator, and every agent
 * room is encrypted. The turn error card (`dev.agentpod.turn_error`, agentpod
 * #573) rides in the message content beside the readable body. This layer
 * rebuilt that content from the body alone, so no agent room ever received a
 * card — supermessage build 23 drew the plain bubble (krishna, 2026-09-26).
 * Nothing tested this file; the card's tests used the plain client.
 */

const HS = "http://homeserver.test";
const ROOM = "!room:id.agentpod.dev";
const AGENT = "@agent_krishna:id.agentpod.dev";
const CARD = { "dev.agentpod.turn_error": { schema_version: 1, kind: "quota", message: "limit", harness: "openclaw" } };

let realFetch: typeof fetch;
let encryptedRoom = true;
/** Whether `/joined_members` answers. A room whose members cannot be read is the case
 *  that silently produced unreadable messages — see agentpod#604. */
let membersReadable = true;
/** Who `/joined_members` reports, so a room containing only the agent can be exercised. */
let joined: string[] = [];

beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/state/m.room.encryption")) {
      return new Response(encryptedRoom ? JSON.stringify({ algorithm: "m.megolm.v1.aes-sha2" }) : "{}", {
        status: encryptedRoom ? 200 : 404,
      });
    }
    if (url.includes("/joined_members")) {
      if (!membersReadable) return new Response(JSON.stringify({ errcode: "M_FORBIDDEN" }), { status: 403 });
      const members = joined.length ? joined : [AGENT, "@rakesh:id.agentpod.dev"];
      return new Response(
        JSON.stringify({ joined: Object.fromEntries(members.map((m) => [m, {}])) }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  encryptedRoom = true;
  membersReadable = true;
  joined = [];
});

function rig() {
  const plain: Array<{ body: string; extra?: Record<string, unknown> }> = [];
  const encrypted: Array<{ eventType: string; content: Record<string, unknown> }> = [];
  const client = {
    sendText: async (_u: string, _r: string, body: string, extra?: Record<string, unknown>) => {
      plain.push({ body, extra });
      return "$plain";
    },
    sendCustomEvent: async () => "$enc",
  } as any;
  const members: string[][] = [];
  const crypto = {
    encrypt: async (_u: string, _r: string, m: string[], eventType: string, content: Record<string, unknown>) => {
      members.push(m);
      encrypted.push({ eventType, content });
      return { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "…" };
    },
  } as any;
  const sender = withEncryption(client, crypto, { homeserverUrl: HS, asToken: "t" });
  return { sender, plain, encrypted, members };
}

describe("a message with extra content keys", () => {
  test("in an encrypted room, the card is inside what gets encrypted", async () => {
    const { sender, encrypted } = rig();
    await sender.sendText(AGENT, ROOM, "This agent reported an error: limit", CARD);
    expect(encrypted).toHaveLength(1);
    expect(encrypted[0]!.eventType).toBe("m.room.message");
    expect(encrypted[0]!.content).toEqual({
      ...CARD,
      msgtype: "m.text",
      body: "This agent reported an error: limit",
    });
  });

  test("in an encrypted room, extra keys cannot replace msgtype or body", async () => {
    const { sender, encrypted } = rig();
    await sender.sendText(AGENT, ROOM, "readable", { body: "hijacked", msgtype: "m.image" });
    expect(encrypted[0]!.content).toMatchObject({ msgtype: "m.text", body: "readable" });
  });

  test("in a plaintext room, the card reaches the plain client", async () => {
    encryptedRoom = false;
    const { sender, plain } = rig();
    await sender.sendText(AGENT, "!plain:id.agentpod.dev", "readable", CARD);
    expect(plain).toEqual([{ body: "readable", extra: CARD }]);
  });
});


/**
 * agentpod#604: every gate the hub encrypted was unreadable, and nothing said so.
 *
 * `membersOf` returned `[]` for any non-OK response, and an empty recipient list means
 * the megolm key is shared with NOBODY — while the message still encrypts, still sends,
 * and still returns an event id. The sender sees success; the room sees ciphertext it
 * can never open.
 */
describe("a room whose members cannot be read", () => {
  test("refuses to send rather than encrypting to nobody", async () => {
    membersReadable = false;
    const { sender, encrypted } = rig();
    await expect(sender.sendText(AGENT, ROOM, "a gate nobody could open")).rejects.toThrow(
      /member/i,
    );
    // Nothing may be encrypted on a guess: an unreadable message in an encrypted room is
    // indistinguishable from a delivered one, which is how this went unnoticed.
    expect(encrypted).toHaveLength(0);
  });

  test("the same refusal covers custom events, which is how a gate travels", async () => {
    membersReadable = false;
    const { sender, encrypted } = rig();
    await expect(
      sender.sendCustomEvent(AGENT, ROOM, "dev.superpipeline.gate.v1", { gateId: "gate_x" }),
    ).rejects.toThrow(/member/i);
    expect(encrypted).toHaveLength(0);
  });

  /**
   * Throwing is not merely tidier than returning null — it is what makes a gate survive.
   * `gates.ts`: "A send that THROWS gives the claim back", so the sweep re-offers it.
   * A silent failure leaves the claim taken and the gate is lost.
   */
  test("the refusal is a throw, so a gate delivery gives its claim back", async () => {
    membersReadable = false;
    const { sender } = rig();
    let threw = false;
    try {
      await sender.sendText(AGENT, ROOM, "x");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("a readable member list still sends, and carries every member", async () => {
    const { sender, encrypted, members } = rig();
    await sender.sendText(AGENT, ROOM, "ordinary");
    expect(encrypted).toHaveLength(1);
    expect(members[0]).toEqual([AGENT, "@rakesh:id.agentpod.dev"]);
  });

  /**
   * A room holding only the agent is not an error — an agent may be alone in its room —
   * but it is the shape of "nobody can read this", so it must not pass unremarked.
   */
  test("a room containing only the sender still sends", async () => {
    joined = [AGENT];
    const { sender, encrypted, members } = rig();
    await sender.sendText(AGENT, ROOM, "talking to myself");
    expect(encrypted).toHaveLength(1);
    expect(members[0]).toEqual([AGENT]);
  });
});

describe("isRoomEncrypted — what a media sender asks before choosing `file` over `url`", () => {
  test("answers from the room's encryption state", async () => {
    const { sender } = rig();
    expect(await sender.isRoomEncrypted!(AGENT, ROOM)).toBe(true);
    encryptedRoom = false;
    expect(await sender.isRoomEncrypted!(AGENT, "!other:id.agentpod.dev")).toBe(false);
  });
});
