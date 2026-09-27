import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const MAX_EXPANDED = 64 << 20;
const MAX_FILES = 4096;
const MAX_FILE_BYTES = 8 << 20;
const digest = /^[a-f0-9]{64}$/;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const harnesses = new Set(["codex", "claude-code", "opencode", "pi", "hermes", "openclaw"]);

type File = { bytes: Buffer; executable: boolean };
type Manifest = {
  schema_version: 1; name: string; version: string; profile: string; harness: string;
  visibility: "private" | "public"; skills: Array<{ id: string; owner: string; source: string; path: string; license: string; notices: string[]; prerequisites: string[]; lifecycle: string }>;
  files: Record<string, { sha256: string; executable: boolean }>; digest: string;
};

function fail(message: string): never { throw new Error(`invalid trusted skill archive: ${message}`); }
function ascii(value: string) { return /^[\x20-\x7e]+$/.test(value); }
function artifactPath(value: string) {
  if (!value || value.length > 1024 || !ascii(value) || value.includes("\\") || value.includes(":") || value.startsWith("/") || value.split("/").length > 64) return false;
  return value.split("/").every((part) => part && part !== "." && part !== ".." && part.length <= 255);
}
function octal(bytes: Buffer) {
  const text = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(text)) fail("invalid tar numeric field");
  return Number.parseInt(text, 8);
}
function checksum(header: Buffer) {
  const expected = octal(header.subarray(148, 156));
  let actual = 0;
  for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i]!;
  return actual === expected;
}
function nullTerminated(bytes: Buffer) { return bytes.toString("utf8").replace(/\0.*$/, ""); }
function zero(block: Buffer) { return block.every((byte) => byte === 0); }
function parsePax(bytes: Buffer) {
  const text = bytes.toString("utf8");
  const values: Record<string, string> = {};
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    if (space < 1) fail("invalid PAX header");
    const length = Number(text.slice(at, space));
    if (!Number.isSafeInteger(length) || length <= space - at + 1 || at + length > text.length) fail("invalid PAX header");
    const line = text.slice(space + 1, at + length);
    if (!line.endsWith("\n")) fail("invalid PAX header");
    const equal = line.indexOf("=");
    if (equal < 1) fail("invalid PAX header");
    const key = line.slice(0, equal), value = line.slice(equal + 1, -1);
    if (key !== "path" || Object.hasOwn(values, key)) fail("unsupported PAX extension");
    values[key] = value;
    at += length;
  }
  return values;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]),
  );
  return value;
}

/**
 * Admission-time structural validation. The node repeats this validation before
 * writing a package; this catches malformed catalog archives before they become
 * trusted release pins.
 */
export function validateTrustedSkillArchive(
  compressed: Buffer, expected: { archiveSHA256: string; harness: string; profile: string; bundleDigest: string },
) {
  if (!digest.test(expected.archiveSHA256) || !digest.test(expected.bundleDigest) || !harnesses.has(expected.harness) || !slug.test(expected.profile)) fail("invalid expected archive identity");
  if (createHash("sha256").update(compressed).digest("hex") !== expected.archiveSHA256) fail("archive digest mismatch");
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: MAX_EXPANDED + 1 }); } catch { fail("invalid gzip payload"); }
  if (tar.length > MAX_EXPANDED) fail("expanded archive exceeds limit");
  const files = new Map<string, File>();
  const seen = new Map<string, { name: string; file: boolean }>();
  let root = "", offset = 0, pax: Record<string, string> | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (zero(header)) {
      if (offset + 512 > tar.length || !zero(tar.subarray(offset, offset + 512))) fail("invalid tar end marker");
      offset += 512;
      if (!zero(tar.subarray(offset))) fail("data follows tar end");
      offset = tar.length;
      break;
    }
    if (!checksum(header)) fail("invalid tar checksum");
    const size = octal(header.subarray(124, 136));
    if (size < 0 || size > MAX_FILE_BYTES || offset + size > tar.length) fail("invalid tar file size");
    const type = String.fromCharCode(header[156]!);
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (offset > tar.length) fail("truncated tar payload");
    if (type === "x") { pax = parsePax(data); continue; }
    if (type !== "\0" && type !== "0") fail("unsupported tar entry");
    if (files.size >= MAX_FILES) fail("too many archive files");
    const mode = octal(header.subarray(100, 108));
    if (mode !== 0o644 && mode !== 0o755) fail("unsupported archive mode");
    const name = pax?.path ?? `${nullTerminated(header.subarray(345, 500))}${nullTerminated(header.subarray(345, 500)) ? "/" : ""}${nullTerminated(header.subarray(0, 100))}`;
    pax = undefined;
    if (!artifactPath(name)) fail("unsafe archive path");
    const split = name.indexOf("/");
    if (split <= 4) fail("invalid bundle root");
    const bundle = name.slice(0, split), relative = name.slice(split + 1);
    if (!bundle.startsWith("sjl-") || !slug.test(bundle) || relative === ".sjl-receipt.json") fail("invalid bundle root or reserved entry");
    if (!root) root = bundle;
    if (root !== bundle) fail("multiple archive roots");
    for (const [index, part] of relative.split("/").entries()) {
      const joined = relative.split("/").slice(0, index + 1).join("/");
      const folded = joined.toLowerCase(), file = index === relative.split("/").length - 1, prior = seen.get(folded);
      if (prior && (prior.name !== joined || prior.file || file)) fail("duplicate, case-colliding or overlapping path");
      if (!prior) seen.set(folded, { name: joined, file });
    }
    files.set(relative, { bytes: Buffer.from(data), executable: mode === 0o755 });
  }
  if (!root || offset !== tar.length) fail("truncated tar archive");
  const raw = files.get("sjl-bundle.json");
  if (!raw || raw.executable || raw.bytes.length === 0 || raw.bytes.length > 2 << 20) fail("missing or invalid bundle manifest");
  let manifest: Manifest;
  try { manifest = JSON.parse(raw.bytes.toString("utf8")) as Manifest; } catch { fail("invalid bundle manifest JSON"); }
  if (manifest.schema_version !== 1 || manifest.name !== root || manifest.name !== `sjl-${expected.profile}` || manifest.profile !== expected.profile || manifest.harness !== expected.harness || !harnesses.has(manifest.harness) || (manifest.visibility !== "private" && manifest.visibility !== "public") || !digest.test(manifest.digest) || manifest.digest !== expected.bundleDigest || !Array.isArray(manifest.skills) || !manifest.skills.length || manifest.skills.length > 256 || !manifest.files || Array.isArray(manifest.files)) fail("bundle identity mismatch");
  if (Object.keys(manifest.files).length + 1 !== files.size) fail("bundle file set mismatch");
  const unsigned = { ...manifest } as Record<string, unknown>;
  delete unsigned.digest;
  if (createHash("sha256").update(`${JSON.stringify(canonical(unsigned), null, 2)}\n`).digest("hex") !== manifest.digest)
    fail("bundle manifest digest mismatch");
  for (const [name, meta] of Object.entries(manifest.files)) {
    const file = files.get(name);
    if (!file || name === "sjl-bundle.json" || !artifactPath(name) || typeof meta?.executable !== "boolean" || !digest.test(meta.sha256) || meta.executable !== file.executable || createHash("sha256").update(file.bytes).digest("hex") !== meta.sha256) fail("bundle file integrity mismatch");
  }
  const ids = new Set<string>();
  for (const skill of manifest.skills) {
    if (!skill || !slug.test(skill.id) || skill.id.length > 64 || ids.has(skill.id) || !skill.owner || !skill.path || !skill.license || !Array.isArray(skill.notices) || !skill.notices.length || !Array.isArray(skill.prerequisites) || !["sjl", "upstream", "product"].includes(skill.source) || !["candidate", "stable", "deprecated"].includes(skill.lifecycle)) fail("invalid skill metadata");
    ids.add(skill.id);
    const entry = files.get(`skills/${skill.id}/SKILL.md`);
    if (!entry || !entry.bytes.toString("utf8").match(/^---\r?\n[\s\S]*?^name:\s*['\"]?([^\s'\"]+)/m)?.[1]?.match(new RegExp(`^${skill.id}$`))) fail("invalid skill entrypoint");
    for (const notice of skill.notices) if (!artifactPath(notice) || !files.has(`notices/${notice}`)) fail("missing license notice");
  }
  return { manifest };
}
