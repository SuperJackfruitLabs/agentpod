import sodium from "libsodium-wrappers";

/**
 * Seal a credential to a station's stk handover public key.
 *
 * The format is frozen by stk (supertoolkit docs/handover-v1.md) and pinned by
 * the conformance vector at packages/contract/fixtures/handover-v1.json.
 * Nothing here logs or echoes its inputs, and error messages never include the
 * key or the material.
 */

const PREFIX = "stk-handover-v1:";
const KEY_BYTES = 32;
const BASE64URL_NOPAD = /^[A-Za-z0-9_-]+$/;

function decode(body: string, what: string): Uint8Array {
  if (!BASE64URL_NOPAD.test(body)) throw new Error(`${what} is not unpadded base64url`);
  try {
    return sodium.from_base64(body, sodium.base64_variants.URLSAFE_NO_PADDING);
  } catch {
    throw new Error(`${what} is not unpadded base64url`);
  }
}

/** Parse `stk-handover-v1:<base64url-nopad 32 bytes>`. Throws on any deviation. */
export function parseHandoverPublicKey(s: string): Uint8Array {
  if (typeof s !== "string" || !s.startsWith(PREFIX)) {
    throw new Error(`handover public key must start with ${PREFIX}`);
  }
  const bytes = decode(s.slice(PREFIX.length), "handover public key");
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`handover public key must be ${KEY_BYTES} bytes`);
  }
  return bytes;
}

/** Returns `stk-handover-v1:<base64url-nopad sealed box>` of the JSON material. */
export async function sealHandover(
  publicKey: string,
  material: Record<string, string>,
): Promise<string> {
  const key = parseHandoverPublicKey(publicKey);
  if (material === null || typeof material !== "object" || Array.isArray(material)) {
    throw new Error("handover material must be an object of strings");
  }
  const entries = Object.entries(material);
  if (entries.length === 0) throw new Error("handover material is empty");
  for (const [, v] of entries) {
    if (typeof v !== "string") throw new Error("handover material values must be strings");
  }
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(JSON.stringify(material), key);
  return PREFIX + sodium.to_base64(sealed, sodium.base64_variants.URLSAFE_NO_PADDING);
}
