/**
 * Linking an agent's file or folder into Superlibrary (spec §5 "AgentPod artifacts", steps 2-5).
 *
 * The station is the caller's own (the caller resolves it; the MCP tool takes no station
 * argument). The node walks and reads with its guardrails (fs.walk, offset fs.read, Tasks A4-A5),
 * and the hub hands the bytes to Superlibrary as itself, naming the agent (plan P1). The hub never
 * acts for a person (operator ruling R-H1): the actor is an agent and nothing else.
 */
import { createHash } from "node:crypto";
import { VERB_RESULTS } from "@agentpod/contract";
import type { SuperlibraryClient } from "./client";

export interface LinkProvenanceOk { board: string; card?: string; run?: string }
export type LinkProvenance = LinkProvenanceOk | { refused: string };

/** The real broker's shape (`services/broker.ts`), so the module itself is passed as it is. */
export interface LinkBroker {
  request(nodeId: string, verb: string, params: unknown, opts?: { timeoutMs?: number }): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}
export interface LinkDeps {
  broker: LinkBroker;
  client: SuperlibraryClient;
  provenance(stationId: string, tenantId: string): Promise<LinkProvenance>;
}
export interface LinkInput {
  station: {
    id: string;
    stationKey: string;
    nodeId: string;
    nodeStatus: string;
    tenantId: string;
    /** The station's advertised capabilities, when known: one without `fs.walk` is too old to link from. */
    capabilities?: readonly string[] | null;
  };
  path: string;
  title?: string;
  kind?: "file" | "folder";
  entry?: string;
  /** Always an agent: the hub never acts for a person (R-H1). */
  actor: { principal: string; kind: "agent" };
}
export type LinkStatus = 400 | 403 | 409 | 413 | 422 | 502 | 503;
export type LinkResult =
  | {
      ok: true; itemId: string; version: number; url: string; sha256: string; mediaType: string; bytes: number;
      /** What the node's walk left out (denied, symlink, special, unreadable), relative to the linked folder. */
      skipped?: Array<{ path: string; reason: string }>;
    }
  | { ok: false; status: LinkStatus; error: string; message: string };

/** One offset read. The node clamps at 4 MiB; 1 MiB keeps each base64 frame small. */
export const CHUNK = 1 << 20;
/** Spec §8 sizes. */
export const MAX_FILE = 25 * 1024 * 1024;
export const MAX_FOLDER_BYTES = 100 * 1024 * 1024;
export const MAX_FOLDER_FILES = 500;
const READ_TIMEOUT_MS = 60_000;
const MESSAGE_CAP = 500;

const refuse = (status: LinkStatus, error: string, message: string): LinkResult => ({ ok: false, status, error, message });
const TOO_OLD = "This node is too old to link files; update it and try again.";
const changed = (p: string) => refuse(409, "file_changed", `${p} changed while it was being read; link it again.`);

// ─── The denylist (spec §8) ───────────────────────────────────────────────────
// The node is authoritative (descriptor/artifact.go `deniedRules`, which mirrors Superlibrary's
// DENIED_RULES), and Superlibrary checks again on its side. This mirror refuses before anything is
// asked of the node. It may only be stricter than the node's.

type Segs = string[];
const anySeg = (f: (s: string) => boolean) => (s: Segs) => s.some(f);
const dirSeg = (name: string) => (s: Segs) => s.slice(0, -1).includes(name);
const base = (f: (b: string) => boolean) => (s: Segs) => f(s[s.length - 1]!);
const sub = (...parts: string[]) => (s: Segs) => {
  for (let i = 0; i + parts.length <= s.length; i++) if (parts.every((p, j) => s[i + j] === p)) return true;
  return false;
};
const HARNESS_DIRS = [".claude", ".codex", ".gemini", ".cursor", ".hermes", ".openclaw", ".opencode", ".pi"];
const DENIED_RULES: Array<[string, (s: Segs) => boolean]> = [
  [".env*", anySeg((x) => x.startsWith(".env"))],
  [".ssh/", dirSeg(".ssh")],
  [".gnupg/", dirSeg(".gnupg")],
  ["*.pem", base((b) => b.endsWith(".pem"))],
  ["*.key", base((b) => b.endsWith(".key"))],
  ["id_*", base((b) => b.startsWith("id_"))],
  [".git/", dirSeg(".git")],
  [".netrc", base((b) => b === ".netrc")],
  [".npmrc", base((b) => b === ".npmrc")],
  [".pypirc", base((b) => b === ".pypirc")],
  [".git-credentials", base((b) => b === ".git-credentials")],
  ["cloud credentials", (s) =>
    dirSeg(".aws")(s) || dirSeg(".azure")(s) || dirSeg(".kube")(s) || sub(".config", "gcloud")(s) || sub(".docker", "config.json")(s) ||
    base((b) => b === "application_default_credentials.json" || b === "credentials.json")(s)],
  ["harness files", (s) =>
    HARNESS_DIRS.some((d) => dirSeg(d)(s)) ||
    base((b) => b === ".claude.json" || b === "auth.json" || b === ".credentials.json")(s) ||
    sub(".config", "opencode")(s) || sub(".local", "share", "opencode")(s) || sub(".config", "goose")(s)],
];

function deniedRule(rel: string): string | null {
  const segs = rel.split("/").filter((x) => x !== "" && x !== ".").map((x) => x.toLowerCase().replace(/[. ]+$/, ""));
  if (segs.length === 0) return null;
  for (const [rule, test] of DENIED_RULES) if (test(segs)) return rule;
  return null;
}

/**
 * Why Superlibrary's `checkPath` (packages/contract/src/paths.ts) would refuse a name, if it would.
 * Checked on every name before anything is read, so a refusal costs no transfer.
 */
function uploadNameRefusal(p: string): string | null {
  if (p.length > 1024) return "its path is too long";
  if (/[\u0000-\u001f\u007f]/.test(p)) return "it contains a control character";
  if (p.includes("\\")) return "it contains a backslash";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "it is an absolute path";
  const parts = p.split("/");
  if (parts.includes("..")) return "it leaves the folder";
  if (parts.filter((x) => x !== "" && x !== ".").length === 0) return "it has no name";
  const rule = deniedRule(p);
  return rule ? `it matches the ${rule} rule` : null;
}

/** A path relative to the workspace, or null when it would leave it. */
function cleanPath(p: string): string | null {
  const segs = p.replace(/\\/g, "/").split("/");
  if (p.replace(/\\/g, "/").startsWith("/")) return null;
  const kept = segs.filter((x) => x !== "" && x !== ".");
  if (kept.length === 0 || kept.includes("..")) return null;
  return kept.join("/");
}

// ─── Node answers ─────────────────────────────────────────────────────────────

const isTooOld = (e: string) => /unknown verb|not supported/i.test(e);
const isUnavailable = (e: string) => e === "node offline" || e === "timeout" || /disconnect/i.test(e);

function walkRefusal(path: string, error: string): LinkResult {
  if (isUnavailable(error)) return refuse(503, "station_unavailable", "This station is unavailable right now, so nothing can be linked from it.");
  if (isTooOld(error)) return refuse(409, "node_too_old", TOO_OLD);
  if (/: not found$/.test(error)) return refuse(400, "not_found", `${path} is not in this station's workspace.`);
  // Denied, escaping, or not a file or folder: the node's sentence names the requested path only.
  return refuse(400, "path_refused", `${path} cannot be linked: ${error}`);
}

async function readWhole(deps: LinkDeps, input: LinkInput, path: string, size: number): Promise<Uint8Array | LinkResult> {
  const out = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const r = await deps.broker.request(
      input.station.nodeId,
      "fs.read",
      { key: input.station.stationKey, path, offset, maxBytes: Math.min(CHUNK, size - offset) },
      { timeoutMs: READ_TIMEOUT_MS },
    );
    if (!r.ok) {
      const e = r.error ?? "fs.read failed";
      if (isUnavailable(e)) return refuse(503, "station_unavailable", "This station became unavailable while the file was read; link it again.");
      if (isTooOld(e)) return refuse(409, "node_too_old", TOO_OLD);
      // Never relay the node's read error: ReadAt returns raw OS errors that carry host-absolute paths.
      return refuse(502, "read_failed", `Could not read ${path}; link it again.`);
    }
    const parsed = VERB_RESULTS["fs.read"].safeParse(r.data);
    if (!parsed.success) return refuse(502, "read_failed", `The node answered an unreadable result for ${path}.`);
    const res = parsed.data;
    // A node that ignores `offset` reads from 0 every time and echoes nothing: refuse, never splice.
    if (res.offset !== offset || res.encoding !== "base64") return refuse(409, "node_too_old", TOO_OLD);
    // Every chunk must report the size the walk listed: a file edited mid-read is torn, not linked.
    // Torn-read detection is size-only: an edit that keeps the size (an in-place rewrite) is not
    // seen here. Superlibrary hashes what it receives, so the item is at least self-consistent.
    if (res.size !== size) return changed(path);
    const bytes = Buffer.from(res.content, "base64");
    if (bytes.length === 0 || offset + bytes.length > size) return changed(path);
    out.set(bytes, offset);
    offset += bytes.length;
    if (offset === size && res.eof === false) return changed(path);
  }
  return out;
}

export async function linkArtifact(deps: LinkDeps, input: LinkInput): Promise<LinkResult> {
  // R-H1: an agent's own file, through the hub, for the agent. A person is never named.
  if ((input.actor as { kind: string }).kind !== "agent" || !input.actor.principal) {
    return refuse(403, "agent_only", "Only an agent links from its own station; a person uploads to Superlibrary directly.");
  }
  if (input.path.length > 1024 || /[\u0000-\u001f\u007f]/.test(input.path)) {
    return refuse(400, "path_refused", "The path is too long or contains a control character.");
  }
  const path = cleanPath(input.path);
  if (!path) return refuse(400, "path_refused", "The path must stay inside the workspace.");
  // A folder is judged by what it would contain too: ".ssh" and ".git" are denied as folders.
  const rule = deniedRule(path) ?? deniedRule(`${path}/x`);
  if (rule) return refuse(400, "path_refused", `${path} is denied by default (${rule}): credentials and harness files are never linked.`);
  if (input.station.nodeStatus !== "online") return refuse(503, "station_unavailable", "This station is unavailable right now, so nothing can be linked from it.");
  if (input.station.capabilities && !input.station.capabilities.includes("fs.walk")) return refuse(409, "node_too_old", TOO_OLD);
  const prov = await deps.provenance(input.station.id, input.station.tenantId);
  if ("refused" in prov) return refuse(409, "no_board", prov.refused);

  const walk = await deps.broker.request(input.station.nodeId, "fs.walk", {
    key: input.station.stationKey, path, maxFiles: MAX_FOLDER_FILES, maxBytes: MAX_FOLDER_BYTES,
  });
  if (!walk.ok) return walkRefusal(path, walk.error ?? "fs.walk failed");
  const parsed = VERB_RESULTS["fs.walk"].safeParse(walk.data);
  if (!parsed.success) return refuse(502, "walk_failed", `The node answered an unreadable listing for ${path}.`);
  const w = parsed.data;

  // Every cap is checked on the whole listing before the first byte is read.
  if (w.tooMany || w.files.length > MAX_FOLDER_FILES) return refuse(413, "too_many_files", `A folder may have at most ${MAX_FOLDER_FILES} files.`);
  if (w.tooLarge || w.files.reduce((n, f) => n + f.size, 0) > MAX_FOLDER_BYTES) return refuse(413, "folder_too_large", "Together these are more than 100 MB, the limit for a folder.");
  if (w.files.length === 0) return refuse(400, "empty", `${path} has no files that can be linked.`);
  const name = path.split("/").pop()!;
  // fs.walk of a file lists it once, as "" (the walked path itself).
  const single = w.files.length === 1 && w.files[0]!.path === "";
  if (input.kind === "file" && !single) return refuse(400, "not_a_file", `${path} is a folder.`);
  if (input.kind === "folder" && single) return refuse(400, "not_a_folder", `${path} is a file.`);
  for (const f of w.files) {
    const shown = single ? name : f.path;
    // The denylist is judged from the workspace too: `.config` + `gcloud/x` is `.config/gcloud/x`.
    const wsRule = single ? null : deniedRule(`${path}/${f.path}`);
    const why = uploadNameRefusal(shown) ?? (wsRule ? `it matches the ${wsRule} rule` : null);
    if (why) return refuse(400, "path_refused", `${single ? path : `${path}/${JSON.stringify(f.path).slice(1, -1)}`} cannot be linked: ${why}.`);
  }
  const big = w.files.find((f) => f.size > MAX_FILE);
  if (big) return refuse(413, "file_too_large", `${big.path || name} is larger than 25 MB, the limit for one file.`);

  const files: Array<{ path: string; bytes: Uint8Array; sha256: string }> = [];
  for (const f of w.files) {
    const bytes = await readWhole(deps, input, single ? path : `${path}/${f.path}`, f.size);
    if (!(bytes instanceof Uint8Array)) return bytes;
    files.push({ path: single ? name : f.path, bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
  }

  const lib = deps.client.asService({ principal: input.actor.principal, kind: "agent" });
  const declare = await lib.request("POST", "/api/v1/uploads", {
    json: {
      title: input.title?.trim() || name,
      scope: `board:${prov.board}`,
      ...(input.entry ? { entry: input.entry } : {}),
      files: files.map((f) => ({ path: f.path, bytes: f.bytes.length, sha256: f.sha256 })),
      // LinkSource is strict on Superlibrary's side: only these keys.
      source: {
        station: input.station.id, stationName: input.station.stationKey, path, board: prov.board,
        ...(prov.card ? { card: prov.card } : {}), ...(prov.run ? { run: prov.run } : {}),
      },
    },
  });
  if (!declare.ok) return fromLibrary(declare);
  const { uploadId } = (await declare.json()) as { uploadId: string };
  for (const f of files) {
    const put = await lib.request("PUT", `/api/v1/uploads/${uploadId}/files?path=${encodeURIComponent(f.path)}`, { body: f.bytes });
    if (!put.ok) return fromLibrary(put);
  }
  const commit = await lib.request("POST", `/api/v1/uploads/${uploadId}/commit`);
  if (!commit.ok) return fromLibrary(commit);
  const c = (await commit.json()) as { itemId: string; version: number; url: string; sha256: string; mediaType: string; bytes: number };
  return {
    ok: true, itemId: c.itemId, version: c.version, url: c.url, sha256: c.sha256, mediaType: c.mediaType, bytes: c.bytes,
    ...(w.skipped.length ? { skipped: w.skipped } : {}),
  };
}

async function fromLibrary(res: Response): Promise<LinkResult> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; findings?: Array<{ path: string; line: number; rule: string }>; path?: string; reason?: string };
  if (body.error === "secret_found") {
    const where = (body.findings ?? []).map((f) => `${f.path} line ${f.line} (${f.rule})`).join(", ");
    return refuse(422, "secret_found", `Not linked: a secret was found in ${where}. Remove it and link again. Nothing was added to the library.`);
  }
  const status = ([400, 403, 409, 413, 422] as const).find((s) => s === res.status) ?? 502;
  const error = status === 502 ? "library_refused" : (body.error ?? "library_refused");
  // `message` is Superlibrary's own sentence, relayed deliberately so the agent sees why; capped so
  // a misbehaving server cannot flood the agent's context.
  const relayed = typeof body.message === "string" ? body.message.slice(0, MESSAGE_CAP) : undefined;
  const message = body.path ? `${body.path}: ${body.reason ?? "refused"}`.slice(0, MESSAGE_CAP) : (relayed ?? `Superlibrary refused the link (${res.status}${body.error ? `, ${body.error}` : ""}).`);
  return refuse(status, error, message);
}
