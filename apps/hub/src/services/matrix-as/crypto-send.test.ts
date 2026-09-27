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
      return new Response(JSON.stringify({ joined: { [AGENT]: {}, "@rakesh:id.agentpod.dev": {} } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  encryptedRoom = true;
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
  const crypto = {
    encrypt: async (_u: string, _r: string, _m: string[], eventType: string, content: Record<string, unknown>) => {
      encrypted.push({ eventType, content });
      return { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "…" };
    },
  } as any;
  const sender = withEncryption(client, crypto, { homeserverUrl: HS, asToken: "t" });
  return { sender, plain, encrypted };
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
