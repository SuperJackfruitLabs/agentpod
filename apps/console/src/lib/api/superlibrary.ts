/**
 * Superlibrary, called by the console itself (Task A9R, operator ruling R-H1: the hub never acts
 * for a person). The person reads their own file through the hub's person route, then uploads it
 * to Superlibrary as an ordinary person upload — declare, send, commit — with their own
 * Superlibrary-audience token (a grant of its own: $lib/auth/superlibrary-grant). No `source`:
 * Superlibrary takes provenance only from the hub linking for an agent, and refuses it from a person.
 *
 * Tokens never cross: the hub's token goes only to the hub (`readFileBytes`), Superlibrary's only
 * to Superlibrary (`library`), and neither request carries a cookie to Superlibrary.
 */
import { superlibraryToken, superlibraryTokenRefused } from "$lib/stores/auth.svelte";
import { FILE_READ_MAX_BYTES, readFileBytes } from "./client";
import { ApiError } from "./http-error";

const DEFAULT_URL = "https://app.superlibrary.dev";

/** Superlibrary's base URL: `PUBLIC_SUPERLIBRARY_URL` at build time, else its app. */
export function superlibraryUrl(): string {
  const configured = (import.meta.env?.PUBLIC_SUPERLIBRARY_URL as string | undefined)?.trim();
  return (configured || DEFAULT_URL).replace(/\/+$/, "");
}

export const TOO_BIG = "This file is over 8 MB; link it from the agent or with the Superlibrary CLI.";

export interface LinkedFile {
  itemId: string;
  version: number;
  url: string;
}

interface Refusal {
  error?: unknown;
  message?: unknown;
  detail?: unknown;
  findings?: unknown;
}

/** Superlibrary's codes that have no sentence of their own in the answer. */
const SAID: Record<string, string> = {
  product_not_enabled: "Superlibrary is not enabled for this workspace.",
  file_too_large: "This file is over Superlibrary's size limit.",
  quota_exceeded: "The workspace's Superlibrary storage is full.",
  path_refused: "Superlibrary does not take files with this name.",
};

/** The sentence for a refusal: the file, line and rule for a secret; else the server's own words. */
async function refusal(res: Response): Promise<string> {
  let body: Refusal | null = null;
  try {
    body = (await res.json()) as Refusal;
  } catch {
    body = null;
  }
  if (body?.error === "secret_found" && Array.isArray(body.findings) && body.findings.length > 0) {
    const where = (body.findings as { path?: unknown; line?: unknown; rule?: unknown }[])
      .map((f) => `${String(f.path)} line ${String(f.line)}: ${String(f.rule)}`)
      .join("; ");
    return `${where} — files with secrets are never linked.`;
  }
  if (res.status === 401) return "Superlibrary did not accept your sign-in — sign in again and retry.";
  const said = [body?.message, body?.detail, body?.error].find((x): x is string => typeof x === "string" && x.trim() !== "");
  if (said && SAID[said]) return SAID[said];
  return said ?? `Superlibrary refused the link (HTTP ${res.status}).`;
}

/** One Superlibrary request with the person's own Superlibrary token; a refusal throws its sentence. */
async function library(token: string, method: string, path: string, init: { body?: BodyInit; type?: string } = {}): Promise<Response> {
  const requestLine = `${method} ${path.split("?")[0]}`;
  let res: Response;
  try {
    res = await fetch(`${superlibraryUrl()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(init.type ? { "content-type": init.type } : {}) },
      body: init.body,
      credentials: "omit",
    });
  } catch (cause) {
    throw new ApiError("Couldn't reach Superlibrary — check your connection.", {
      status: null,
      detail: `${requestLine} → ${cause instanceof Error ? cause.message : "network error"}`,
    });
  }
  if (res.ok) return res;
  if (res.status === 401) superlibraryTokenRefused(token);
  throw new ApiError(await refusal(res), { status: res.status, detail: `${requestLine} → ${res.status}` });
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  // A view, not the buffer itself: some runtimes refuse an ArrayBuffer from another realm.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Link one of the station's files into Superlibrary as the signed-in person. Answers the new
 * item (or version) and its URL.
 */
export async function linkFileToLibrary(stationId: string, path: string): Promise<LinkedFile> {
  // First, in the click's own tick: the first link of a session opens Superlibrary's sign-in window,
  // and a browser blocks a window opened after an await. It runs while the hub reads the file.
  const tokenAsked = superlibraryToken();
  tokenAsked.catch(() => {}); // a failed read below is the error to report; this one is awaited later
  const { bytes, truncated } = await readFileBytes(stationId, path);
  // The node marks a cut read; a read that fills the ceiling is refused too, in case the mark is lost.
  if (truncated || bytes.byteLength >= FILE_READ_MAX_BYTES) throw new Error(TOO_BIG);
  const name = path.split("/").filter(Boolean).pop() ?? path;
  const sha256 = await sha256Hex(bytes);
  const token = await tokenAsked;

  const declared = await library(token, "POST", "/api/v1/uploads", {
    type: "application/json",
    body: JSON.stringify({ title: name.slice(0, 200), files: [{ path: name, bytes: bytes.byteLength, sha256 }] }),
  });
  const { uploadId } = (await declared.json()) as { uploadId: string };
  const upload = `/api/v1/uploads/${encodeURIComponent(uploadId)}`;
  await library(token, "PUT", `${upload}/files?path=${encodeURIComponent(name)}`, {
    type: "application/octet-stream",
    body: bytes,
  });
  const committed = await library(token, "POST", `${upload}/commit`);
  const { itemId, version, url } = (await committed.json()) as LinkedFile;
  return { itemId, version, url };
}
