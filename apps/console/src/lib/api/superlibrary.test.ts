/**
 * "Link this file" (Task A9R, operator ruling R-H1): the console reads the person's own file
 * through the hub's person route, then hands it to Superlibrary itself, with the person's own
 * Superlibrary-audience token. The hub never acts for the person, the hub's token never reaches
 * Superlibrary, and Superlibrary's token never reaches the hub.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as authStore from "$lib/stores/auth.svelte";
import { linkFileToLibrary, superlibraryUrl } from "./superlibrary";

const HUB = "https://hub.test";
const SL = "https://app.superlibrary.dev";
const STATION = "st_00000000000000a1";
const UPLOAD = "upl_00000000000000c1";
const ITEM = "itm_00000000000000d1";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Seen {
  url: string;
  method: string;
  bearer: string | null;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

/** Hub and Superlibrary as one fake network; every request is recorded with its bearer. */
function network(opts: {
  file?: { bytes: Uint8Array<ArrayBuffer>; truncated?: boolean };
  declare?: () => Response;
  put?: () => Response;
  commit?: () => Response;
} = {}) {
  const seen: Seen[] = [];
  const bytes = opts.file?.bytes ?? new TextEncoder().encode("# Notes\n");
  const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body;
    seen.push({
      url,
      method,
      bearer: new Headers(init?.headers).get("authorization"),
      credentials: init?.credentials,
      body: typeof body === "string" ? JSON.parse(body) : body,
    });
    if (url.startsWith(`${HUB}/api/stations/${STATION}/file?`)) {
      return new Response(bytes, {
        headers: { "content-type": "application/octet-stream", "X-Truncated": String(opts.file?.truncated ?? false) },
      });
    }
    if (url === `${SL}/api/v1/uploads` && method === "POST") {
      return opts.declare?.() ?? json(201, { uploadId: UPLOAD, expiresAt: "2026-10-10T00:00:00Z", entry: "notes.md", held: [] });
    }
    if (url.startsWith(`${SL}/api/v1/uploads/${UPLOAD}/files?`) && method === "PUT") {
      return opts.put?.() ?? json(200, { path: "notes.md", mediaType: "text/markdown", view: "markdown", findings: [] });
    }
    if (url === `${SL}/api/v1/uploads/${UPLOAD}/commit` && method === "POST") {
      return opts.commit?.() ?? json(201, { itemId: ITEM, version: 1, url: `${SL}/a/${ITEM}`, sha256: "x", mediaType: "text/markdown", bytes: 8 });
    }
    return json(404, { error: "not_found" });
  });
  return { seen, fetch: f, toLibrary: () => seen.filter((s) => s.url.startsWith(SL)), toHub: () => seen.filter((s) => s.url.startsWith(HUB)) };
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  localStorage.setItem("agentpod.apiUrl", HUB);
  vi.spyOn(authStore, "getToken").mockResolvedValue("hub-token");
  vi.spyOn(authStore, "superlibraryToken").mockResolvedValue("library-token");
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllEnvs();
});

describe("linkFileToLibrary", () => {
  test("reads the file from the hub, then declares, sends and commits it at Superlibrary", async () => {
    const net = network();
    const out = await linkFileToLibrary(STATION, "docs/notes.md");
    expect(out).toEqual({ itemId: ITEM, version: 1, url: `${SL}/a/${ITEM}` });

    const [read] = net.toHub();
    expect(read!.url).toBe(`${HUB}/api/stations/${STATION}/file?path=docs%2Fnotes.md&maxBytes=8388608`);
    expect(net.toLibrary().map((s) => `${s.method} ${s.url.replace(SL, "")}`)).toEqual([
      "POST /api/v1/uploads",
      `PUT /api/v1/uploads/${UPLOAD}/files?path=notes.md`,
      `POST /api/v1/uploads/${UPLOAD}/commit`,
    ]);
    // The order: nothing reaches Superlibrary before the bytes are read.
    expect(net.seen[0]!.url.startsWith(HUB)).toBe(true);
  });

  test("Superlibrary gets the person's Superlibrary token and never the hub's; the hub never gets Superlibrary's", async () => {
    const net = network();
    await linkFileToLibrary(STATION, "docs/notes.md");
    for (const s of net.toLibrary()) {
      expect(s.bearer).toBe("Bearer library-token");
      expect(s.credentials).toBe("omit");
    }
    for (const s of net.toHub()) expect(s.bearer).toBe("Bearer hub-token");
    expect(JSON.stringify(net.toLibrary())).not.toContain("hub-token");
    expect(JSON.stringify(net.toHub())).not.toContain("library-token");
  });

  test("declares the basename, the exact byte count and its SHA-256, and no source", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x80]);
    const net = network({ file: { bytes } });
    await linkFileToLibrary(STATION, "art/logo.png");
    const declare = net.toLibrary()[0]!;
    expect(declare.body).toEqual({ title: "logo.png", files: [{ path: "logo.png", bytes: 8, sha256: await sha256Hex(bytes) }] });
    expect(declare.body).not.toHaveProperty("source");
    expect(declare.body).not.toHaveProperty("scope"); // the person's default, as Superlibrary's own upload page sends
    // The bytes go out unchanged: binary is never decoded as text.
    const put = net.toLibrary()[1]!;
    expect(new Uint8Array(put.body as ArrayBuffer)).toEqual(bytes);
  });

  test("a file over the hub's 8 MB read is refused before anything reaches Superlibrary", async () => {
    const net = network({ file: { bytes: new Uint8Array(16), truncated: true } });
    await expect(linkFileToLibrary(STATION, "big.bin")).rejects.toThrow(
      "This file is over 8 MB; link it from the agent or with the Superlibrary CLI.",
    );
    expect(net.toLibrary()).toEqual([]);
    expect(authStore.superlibraryToken).not.toHaveBeenCalled();
  });

  test("a secret refusal names the file, the line and the rule", async () => {
    network({
      commit: () => json(422, { error: "secret_found", findings: [{ path: "config.yaml", line: 2, rule: "github-token" }] }),
    });
    await expect(linkFileToLibrary(STATION, "app/config.yaml")).rejects.toThrow(
      "config.yaml line 2: github-token — files with secrets are never linked.",
    );
  });

  test("other refusals carry Superlibrary's own words", async () => {
    network({ declare: () => json(400, { error: "invalid", detail: "expiresAt must be in the future" }) });
    await expect(linkFileToLibrary(STATION, "a.txt")).rejects.toThrow("expiresAt must be in the future");
    vi.restoreAllMocks();
    vi.spyOn(authStore, "getToken").mockResolvedValue("hub-token");
    vi.spyOn(authStore, "superlibraryToken").mockResolvedValue("library-token");
    network({ declare: () => json(403, { error: "product_not_enabled" }) });
    await expect(linkFileToLibrary(STATION, "a.txt")).rejects.toThrow("Superlibrary is not enabled for this workspace.");
  });

  test("a 401 from Superlibrary drops that token, so the next link asks for a fresh one", async () => {
    const refused = vi.spyOn(authStore, "superlibraryTokenRefused").mockImplementation(() => {});
    network({ declare: () => json(401, { error: "unauthorized" }) });
    await expect(linkFileToLibrary(STATION, "a.txt")).rejects.toThrow(/sign in/i);
    expect(refused).toHaveBeenCalledWith("library-token");
  });

  test("Superlibrary out of reach says so, not that the hub is", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith(HUB)) return new Response("x", { headers: { "X-Truncated": "false" } });
      throw new TypeError("Failed to fetch");
    });
    await expect(linkFileToLibrary(STATION, "a.txt")).rejects.toThrow("Couldn't reach Superlibrary — check your connection.");
  });

  test("the hub's read failing is the hub's error, and Superlibrary is not called", async () => {
    const net = network();
    net.fetch.mockImplementationOnce(async () => json(502, { error: "Node offline" }));
    await expect(linkFileToLibrary(STATION, "a.txt")).rejects.toThrow("Node offline.");
    expect(net.toLibrary()).toEqual([]);
  });
});

describe("superlibraryUrl", () => {
  test("defaults to Superlibrary's app, and follows PUBLIC_SUPERLIBRARY_URL", () => {
    expect(superlibraryUrl()).toBe(SL);
    vi.stubEnv("PUBLIC_SUPERLIBRARY_URL", "https://library.test/");
    expect(superlibraryUrl()).toBe("https://library.test");
  });
});
