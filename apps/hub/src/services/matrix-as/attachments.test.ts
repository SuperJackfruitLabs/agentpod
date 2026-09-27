import { describe, expect, test } from "bun:test";
import {
  MAX_IMAGE_BYTES,
  decryptAttachment,
  imageNote,
  imageSource,
  isRefusal,
  loadImage,
  parseMxc,
  promptBlocks,
  type EncryptedFile,
  type PromptImage,
} from "./attachments";

/** A PNG's signature plus a little, enough for type sniffing. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** Encrypt the way a Matrix client does, so decryption meets real ciphertext. */
async function encryptLikeAClient(plain: Uint8Array): Promise<{ cipher: Uint8Array; file: EncryptedFile }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-CTR" }, true, ["encrypt"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  // The spec: 8 random bytes then a zeroed 64-bit counter.
  const iv = new Uint8Array(16);
  iv.set(crypto.getRandomValues(new Uint8Array(8)));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 64 }, key, plain)
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", cipher));
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/=+$/, "");
  return {
    cipher,
    file: {
      url: "mxc://id.agentpod.dev/cipher",
      key: { k: jwk.k!, alg: "A256CTR", kty: "oct" },
      iv: b64(iv),
      hashes: { sha256: b64(digest) },
      v: "v2",
    },
  };
}

describe("imageSource", () => {
  test("a bare image's body is its file name, not a caption", () => {
    // The 2026-09-24 bug: this body was sent to Krishna as the message.
    const src = imageSource({
      msgtype: "m.image",
      body: "03_agrarian_heartland.png",
      url: "mxc://id.agentpod.dev/abc",
      info: { mimetype: "image/png", size: 1234 },
    });
    expect(src?.caption).toBe("");
    expect(src?.name).toBe("03_agrarian_heartland.png");
    expect(src?.mxc).toBe("mxc://id.agentpod.dev/abc");
    expect(src?.file).toBeNull();
  });

  test("with a filename, a different body is the caption (MSC2530)", () => {
    const src = imageSource({
      msgtype: "m.image",
      body: "What region is this?",
      filename: "map.png",
      url: "mxc://id.agentpod.dev/abc",
    });
    expect(src?.caption).toBe("What region is this?");
    expect(src?.name).toBe("map.png");
  });

  test("an encrypted image points at its ciphertext", async () => {
    const { file } = await encryptLikeAClient(PNG);
    const src = imageSource({ msgtype: "m.image", body: "x.png", file, info: { mimetype: "image/png" } });
    expect(src?.mxc).toBe(file.url);
    expect(src?.file).not.toBeNull();
  });

  test("anything that is not an image is not one", () => {
    expect(imageSource({ msgtype: "m.text", body: "hi" })).toBeNull();
    expect(imageSource({ msgtype: "m.audio", body: "voice.ogg", url: "mxc://a/b" })).toBeNull();
    expect(imageSource({ msgtype: "m.image", body: "no url" })).toBeNull();
    expect(imageSource(undefined)).toBeNull();
  });
});

describe("parseMxc", () => {
  test("splits server and media id", () => {
    expect(parseMxc("mxc://id.agentpod.dev/AbC123")).toEqual({
      server: "id.agentpod.dev",
      mediaId: "AbC123",
    });
    expect(parseMxc("https://example.org/x")).toBeNull();
    expect(parseMxc("mxc://only-server")).toBeNull();
  });
});

describe("decryptAttachment", () => {
  test("round-trips a client-encrypted attachment", async () => {
    const { cipher, file } = await encryptLikeAClient(PNG);
    expect(await decryptAttachment(cipher, file)).toEqual(PNG);
  });

  test("refuses a ciphertext that fails its hash, before decrypting", async () => {
    const { cipher, file } = await encryptLikeAClient(PNG);
    const tampered = cipher.slice();
    tampered[0] = tampered[0]! ^ 0xff;
    await expect(decryptAttachment(tampered, file)).rejects.toThrow("integrity");
  });
});

describe("loadImage", () => {
  const plainSource = {
    mxc: "mxc://id.agentpod.dev/abc",
    file: null,
    mimeType: "image/png",
    name: "map.png",
    caption: "",
    size: PNG.length,
  };

  test("a plain image becomes base64 for the prompt", async () => {
    const out = await loadImage(plainSource, async () => PNG);
    expect(isRefusal(out)).toBe(false);
    const image = out as PromptImage;
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64")).toEqual(Buffer.from(PNG));
  });

  test("an encrypted image is decrypted before it is sent", async () => {
    const { cipher, file } = await encryptLikeAClient(PNG);
    const out = await loadImage({ ...plainSource, mxc: file.url, file }, async (mxc) => {
      expect(mxc).toBe(file.url);
      return cipher;
    });
    expect(Buffer.from((out as PromptImage).data, "base64")).toEqual(Buffer.from(PNG));
  });

  test("a failed download is a reason, not an exception", async () => {
    const out = await loadImage(plainSource, async () => {
      throw new Error("network");
    });
    expect(out).toEqual({ reason: "it could not be downloaded" });
  });

  test("too large is refused without downloading", async () => {
    let downloaded = false;
    const out = await loadImage({ ...plainSource, size: MAX_IMAGE_BYTES * 2 }, async () => {
      downloaded = true;
      return PNG;
    });
    expect(downloaded).toBe(false);
    expect(isRefusal(out)).toBe(true);
  });

  test("an unlabelled image is recognised by its bytes", async () => {
    const out = await loadImage({ ...plainSource, mimeType: "" }, async () => PNG);
    expect((out as PromptImage).mimeType).toBe("image/png");
  });

  test("a format no agent can view is named, not sent", async () => {
    const out = await loadImage(
      { ...plainSource, mimeType: "image/heic" },
      async () => new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74])
    );
    expect(isRefusal(out)).toBe(true);
    expect((out as { reason: string }).reason).toContain("image/heic");
  });
});

describe("promptBlocks", () => {
  const image: PromptImage = { mimeType: "image/png", data: "AAAA", name: "map.png", bytes: 3 };

  test("the image leads, the words follow", () => {
    expect(promptBlocks("What is this?", [image], null)).toEqual([
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "text", text: "What is this?" },
    ]);
  });

  test("a bare image is sent without an empty text block", () => {
    expect(promptBlocks("", [image], null)).toEqual([
      { type: "image", mimeType: "image/png", data: "AAAA" },
    ]);
  });

  test("plain text is unchanged from before", () => {
    expect(promptBlocks("hello", [], null)).toEqual([{ type: "text", text: "hello" }]);
    expect(promptBlocks("hello", [], "never used")).toEqual([{ type: "text", text: "hello" }]);
  });

  test("an agent that cannot view images gets a note, never a block it would refuse", () => {
    expect(promptBlocks("What is this?", [image], "this agent cannot view images")).toEqual([
      { type: "text", text: `What is this?\n${imageNote("map.png", "this agent cannot view images")}` },
    ]);
  });
});
