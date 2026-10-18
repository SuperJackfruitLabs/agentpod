import { describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";
import vector from "../../../../packages/contract/fixtures/handover-v1.json";
import { parseHandoverPublicKey, sealHandover } from "../../src/services/handover-seal";

const PREFIX = "stk-handover-v1:";

function b64urlDecode(s: string): Uint8Array {
  return sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/** Open an envelope with the vector keypair, derived from its private key. */
async function open(envelope: string): Promise<Record<string, string>> {
  await sodium.ready;
  expect(envelope.startsWith(PREFIX)).toBe(true);
  const sk = b64urlDecode(vector.private_key);
  const pk = sodium.crypto_scalarmult_base(sk);
  const plain = sodium.crypto_box_seal_open(b64urlDecode(envelope.slice(PREFIX.length)), pk, sk);
  return JSON.parse(sodium.to_string(plain));
}

describe("handover seal", () => {
  test("the vector private key derives the vector public key", async () => {
    const parsed = parseHandoverPublicKey(vector.public_key);
    await sodium.ready;
    const pk = sodium.crypto_scalarmult_base(b64urlDecode(vector.private_key));
    expect(parsed).toEqual(pk);
  });

  test("seals material that the vector private key opens", async () => {
    const env = await sealHandover(vector.public_key, vector.material);
    expect(await open(env)).toEqual(vector.material);
  });

  test("two seals of the same material differ", async () => {
    const a = await sealHandover(vector.public_key, vector.material);
    const b = await sealHandover(vector.public_key, vector.material);
    expect(a).not.toBe(b);
  });

  test("the envelope contains no plaintext", async () => {
    const env = await sealHandover(vector.public_key, vector.material);
    const token = vector.material.token;
    expect(env).not.toContain(token);
    const raw = Buffer.from(b64urlDecode(env.slice(PREFIX.length))).toString("latin1");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain("token");
  });

  test("rejects a key without the stk-handover-v1 prefix", async () => {
    const bare = vector.public_key.slice(PREFIX.length);
    expect(() => parseHandoverPublicKey(bare)).toThrow();
    await expect(sealHandover(bare, vector.material)).rejects.toThrow();
  });

  test("rejects wrong length", async () => {
    const short = PREFIX + Buffer.alloc(31).toString("base64url");
    const long = PREFIX + Buffer.alloc(33).toString("base64url");
    expect(() => parseHandoverPublicKey(short)).toThrow();
    expect(() => parseHandoverPublicKey(long)).toThrow();
    await expect(sealHandover(short, vector.material)).rejects.toThrow();
  });

  test("rejects embedded CR/LF in a key", () => {
    expect(() => parseHandoverPublicKey(vector.public_key + "\n")).toThrow();
    expect(() => parseHandoverPublicKey(PREFIX + "B6N8vBQgk8i3Vdwb\r\nEOhstCY3StFqqFPtC9_AsrhtHHw")).toThrow();
  });

  test("rejects bad base64 and padded base64", () => {
    expect(() => parseHandoverPublicKey(PREFIX + "!!!not base64!!!")).toThrow();
    expect(() => parseHandoverPublicKey(vector.public_key + "=")).toThrow();
  });

  test("rejects empty material and non-string values", async () => {
    await expect(sealHandover(vector.public_key, {})).rejects.toThrow();
    await expect(
      sealHandover(vector.public_key, { token: 5 } as unknown as Record<string, string>),
    ).rejects.toThrow();
  });

  test("opens the recorded vector envelope to the recorded material", async () => {
    expect(await open(vector.envelope)).toEqual(vector.material);
  });
});
