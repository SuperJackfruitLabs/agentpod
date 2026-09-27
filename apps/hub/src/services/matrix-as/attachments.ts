/**
 * Images sent into a bridged room, made into something an agent can see.
 *
 * Every ACP adapter AgentPod runs declares `promptCapabilities.image: true`
 * (Claude Code, Codex, OpenCode, Pi, Hermes and OpenClaw, probed 2026-09-24),
 * and OpenClaw hands image blocks to its model as attachments. The bridge was
 * the only link that dropped them: it read an `m.image` event's `body` — the
 * file name — and prompted with that, so Krishna was asked to discuss
 * "03_agrarian_heartland.png" and said, correctly, that it could not see it.
 *
 * Here: find the image in the event, fetch it as the agent, decrypt it when
 * the room is encrypted, and hand back what `promptSession` sends. Pure apart
 * from the injected download, so all of it is testable without a homeserver.
 */

/** The biggest image passed to an agent, before base64. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Types every model behind the adapters accepts. Anything else — HEIC, TIFF,
 * SVG — is named to the agent rather than sent and refused downstream.
 */
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The Matrix spec's `EncryptedFile`: how an encrypted room carries media. */
export interface EncryptedFile {
  url: string;
  key: { k: string; alg?: string; kty?: string };
  iv: string;
  hashes: { sha256?: string };
  v?: string;
}

/** An image an event refers to. */
export interface ImageSource {
  /** `mxc://server/id` — plain, or the ciphertext when `file` is set. */
  mxc: string;
  file: EncryptedFile | null;
  mimeType: string;
  name: string;
  /** What the sender wrote with it, or "" for a bare image. */
  caption: string;
  size: number | null;
}

/** An image ready for an ACP prompt. */
export interface PromptImage {
  mimeType: string;
  /** Base64, as ACP's image content block carries it. */
  data: string;
  name: string;
  bytes: number;
}

/**
 * The image an `m.image` message carries, or null for any other message.
 *
 * The caption rule is MSC2530's: when `filename` is present and `body`
 * differs from it, `body` is a caption. Otherwise `body` is only the file
 * name, and treating it as the sender's words was the original bug.
 */
export function imageSource(content: Record<string, unknown> | undefined): ImageSource | null {
  if (!content || content.msgtype !== "m.image") return null;

  const file = asEncryptedFile(content.file);
  const mxc = file?.url ?? (typeof content.url === "string" ? content.url : null);
  if (!mxc || !mxc.startsWith("mxc://")) return null;

  const info = (content.info ?? {}) as Record<string, unknown>;
  const body = typeof content.body === "string" ? content.body : "";
  const filename = typeof content.filename === "string" ? content.filename : null;
  const caption = filename !== null && body !== filename ? body : "";

  return {
    mxc,
    file,
    mimeType: typeof info.mimetype === "string" ? info.mimetype : "",
    name: filename ?? (body || "image"),
    caption,
    size: typeof info.size === "number" ? info.size : null,
  };
}

function asEncryptedFile(value: unknown): EncryptedFile | null {
  if (!value || typeof value !== "object") return null;
  const f = value as Record<string, unknown>;
  const key = f.key as Record<string, unknown> | undefined;
  const hashes = f.hashes as Record<string, unknown> | undefined;
  if (
    typeof f.url !== "string" ||
    typeof f.iv !== "string" ||
    !key ||
    typeof key.k !== "string" ||
    !hashes
  ) {
    return null;
  }
  return f as unknown as EncryptedFile;
}

/** Split `mxc://server/mediaId`, or null when it is not one. */
export function parseMxc(mxc: string): { server: string; mediaId: string } | null {
  const match = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxc);
  return match ? { server: match[1]!, mediaId: match[2]! } : null;
}

/**
 * Decrypt an encrypted attachment, per the Matrix spec's "Sending encrypted
 * attachments": AES-256-CTR with a 64-bit counter, key as a JWK, and the
 * ciphertext's SHA-256 checked *before* decrypting, so a swapped or truncated
 * download is refused rather than decrypted into garbage.
 */
export async function decryptAttachment(
  ciphertext: Uint8Array,
  file: EncryptedFile
): Promise<Uint8Array> {
  const expected = file.hashes.sha256;
  if (!expected) throw new Error("the attachment carries no SHA-256 to check");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext));
  if (unpaddedBase64(digest) !== expected.replace(/=+$/, "")) {
    throw new Error("the attachment failed its integrity check");
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "oct", k: file.key.k, alg: "A256CTR", ext: true, key_ops: ["encrypt", "decrypt"] },
    { name: "AES-CTR" },
    false,
    ["decrypt"]
  );
  const counter = base64ToBytes(file.iv);
  if (counter.length !== 16) throw new Error("the attachment's IV is not 16 bytes");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CTR", counter, length: 64 },
    key,
    ciphertext
  );
  return new Uint8Array(plain);
}

/** Why an image could not be passed on, in words an agent can relay. */
export type ImageRefusal = { reason: string };

/**
 * Fetch, decrypt and check one image.
 *
 * Returns the prompt image, or the reason it could not be had. Never throws:
 * a message with an unreadable picture still reaches the agent, with the
 * reason in place of the picture.
 */
export async function loadImage(
  source: ImageSource,
  download: (mxc: string) => Promise<Uint8Array | null>
): Promise<PromptImage | ImageRefusal> {
  if (source.size !== null && source.size > MAX_IMAGE_BYTES * 1.1) {
    return { reason: `it is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB` };
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await download(source.mxc);
  } catch {
    bytes = null;
  }
  if (!bytes) return { reason: "it could not be downloaded" };

  if (source.file) {
    try {
      bytes = await decryptAttachment(bytes, source.file);
    } catch (err) {
      return { reason: err instanceof Error ? err.message : "it could not be decrypted" };
    }
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { reason: `it is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB` };
  }

  const mimeType = IMAGE_TYPES.has(source.mimeType) ? source.mimeType : sniffImageType(bytes);
  if (!mimeType) {
    return { reason: `its format (${source.mimeType || "unknown"}) is not one an agent can view` };
  }
  return { mimeType, data: bytesToBase64(bytes), name: source.name, bytes: bytes.length };
}

export function isRefusal(value: PromptImage | ImageRefusal): value is ImageRefusal {
  return "reason" in value;
}

/**
 * The text an agent reads in place of an image it will not receive, so it
 * never has only a file name to guess from.
 */
export function imageNote(name: string, reason: string): string {
  return `[The user sent an image, ${name}, but ${reason}.]`;
}

/**
 * The ACP prompt for one turn: images first, then the words.
 *
 * Images lead because that is how a person sends them — the picture, then
 * "what is this?". `refusal` is why the images cannot be sent this time — the
 * agent never said it takes them, or its node would drop a frame that large —
 * and the agent then gets that reason in the text instead of a block.
 */
export function promptBlocks(
  text: string,
  images: PromptImage[],
  refusal: string | null
): Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> {
  if (refusal !== null) {
    const notes = images.map((image) => imageNote(image.name, refusal));
    const joined = [text, ...notes].filter((part) => part.trim() !== "").join("\n");
    return [{ type: "text", text: joined }];
  }
  const blocks: Array<
    { type: "text"; text: string } | { type: "image"; mimeType: string; data: string }
  > = images.map((image) => ({ type: "image", mimeType: image.mimeType, data: image.data }));
  if (text.trim() !== "" || blocks.length === 0) blocks.push({ type: "text", text });
  return blocks;
}

/** Recognise the four accepted formats by their first bytes. */
function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return null;
}

function base64ToBytes(value: string): Uint8Array {
  const normal = value.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(normal, "base64"));
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function unpaddedBase64(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=+$/, "");
}
