/** PROPOSED dedicated coordinator data. Optional private handlers do not enable a capability or authority. */
import { z } from "zod";

export const BENCH_COORDINATOR_VERSION = "agentpod.bench-coordinator.v1";
export const BENCH_COORDINATOR_MAX_REQUEST = 64 * 1024;
export const BENCH_COORDINATOR_MAX_RESPONSE = 256 * 1024;
/** PROPOSED explicit broker verb; handlers and installation opt-in are separate gates. */
export const BENCH_COORDINATOR_VERB = "bench.coordinator";
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const scalar = (value: string) => {
  for (const part of value) {
    const c = part.codePointAt(0) ?? 0;
    if (c >= 0xd800 && c <= 0xdfff) return false;
  }
  return true;
};
const id = z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}(?![\s\S])/);
const product = (prefix: string) => z.string().max(128).regex(new RegExp(`^${prefix}_[A-Za-z0-9]{6,}(?![\\s\\S])`));
const sha = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const bid = z.string().regex(/^[a-f0-9]{32}(?![\s\S])/);
const name = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}(?![\s\S])/);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}(?![\s\S])/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/);
const taskRef = z.string().max(256).regex(/^refs\/heads\/card\/card_[A-Za-z0-9]{6,}(?![\s\S])/);
export const BenchCoordinatorIdentity = z.object({
  tenant_id: id, board_id: product("brd"), card_id: product("card"), stage_id: id,
  run_id: product("run"), epoch: integer.min(1), agent_id: product("agt"), station_id: id,
  node_id: id, attempt_id: id, control_principal_id: product("prn"),
  // Historical private name: an opaque selected-authorization snapshot binding, NOT an issuer grant.
  control_grant_id: id, policy_sha256: sha,
}).strict();
export const BenchCoordinatorTarget = z.object({
  tenant_id: id, board_id: product("brd"), agent_id: product("agt"), station_id: id, node_id: id,
  host_id: id, registry_sha256: sha, coordinator_implementation_sha256: sha,
  execution_mode: z.literal("linux-cgroup-v2"), bench_protocol: z.literal("superbench.v2"),
  worker_version: z.literal("agentpod.superbench-worker.v2"), worker_sha256: sha,
}).strict();
const sourceShape = z.object({ name, repository_sha256: sha, task_ref: taskRef, commit }).strict();
const member = z.object({ name, repository_sha256: sha, task_ref: taskRef,
  object_format: z.enum(["sha1", "sha256"]), commit }).strict()
  .refine((m) => m.commit.length === (m.object_format === "sha1" ? 40 : 64));
const checkpoint = z.object({ generation_id: bid, manifest_sha256: sha,
  members: z.array(z.object({ name, commit }).strict()).min(1).max(32), seal: commit, previous_seal: commit.optional() }).strict();
const observed = z.object({ step: z.enum(["create", "lease", "checkpoint"]), request_sha256: sha,
  body_sha256: sha, response_sha256: sha, http_status: z.literal(200), phase: z.literal("observed") }).strict();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (v: Array<{ name: string }>) => v.every((m, i) => i === 0 || (v[i - 1]?.name ?? "") < m.name);
export const BenchCoordinatorSourceBinding = z.object({
  identity: BenchCoordinatorIdentity, host_id: id, bench_key: key, bench_id: bid,
  sources: z.array(sourceShape).min(1).max(32), members: z.array(member).min(1).max(32),
  checkpoint, operations: z.array(observed).min(2).max(3),
  request_sha256: sha, body_sha256: sha, context_sha256: sha, worker_sha256: sha,
}).strict().refine((b) => sorted(b.sources) && sorted(b.members) &&
  new Set(b.sources.map((m) => m.repository_sha256)).size === b.sources.length &&
  b.sources.length === b.members.length && b.members.length === b.checkpoint.members.length &&
  b.sources.every((m, i) => {
    const peer = b.members[i]; const cp = b.checkpoint.members[i];
    return peer?.name === m.name && peer.repository_sha256 === m.repository_sha256 && peer.task_ref === m.task_ref &&
      peer.commit === m.commit && cp?.name === m.name && cp.commit === m.commit &&
      m.task_ref === `refs/heads/card/${b.identity.card_id}`;
  }) && same(b.operations.map((o) => o.step), b.operations.length === 3 ? ["create", "lease", "checkpoint"] : ["lease", "checkpoint"]));
export type BenchCoordinatorSourceBinding = z.infer<typeof BenchCoordinatorSourceBinding>;
export const BenchCoordinatorPrepared = z.object({
  binding: BenchCoordinatorSourceBinding, binding_sha256: sha,
  request_id: key, checkpoint_repository: name, source_request_sha256: sha,
}).strict().refine((p) => {
  const coordinator = p.binding.members.find((m) => m.name === p.checkpoint_repository);
  return coordinator !== undefined && p.binding.checkpoint.seal.length === (coordinator.object_format === "sha1" ? 40 : 64) &&
    (p.binding.checkpoint.previous_seal === undefined || p.binding.checkpoint.previous_seal.length === p.binding.checkpoint.seal.length);
});
const service = z.object({ request_id: key, request_sha256: sha, body_sha256: sha,
  response_sha256: sha, worker_result_sha256: sha, execution_id: bid,
  stopped: z.literal(true), released: z.literal(true), checkpoints: z.array(sourceShape).min(1).max(32),
  kind: z.literal("grouped-v2"), generation_id: bid, seal_commit: commit, manifest_sha256: sha }).strict();
const handoff = z.custom<Record<string, string>>((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Object.entries(value).every(([field, text]) => scalar(field) && typeof text === "string" && scalar(text));
}).transform((value) => Object.fromEntries(Object.entries(value)));
const task = z.object({ version: z.literal("agentpod.superbench-worker.v2"), binding: z.object({
  board_id: product("brd"), card_id: product("card"), run_id: product("run"), epoch: integer.min(1),
}).strict(), outcome: z.enum(["complete", "blocked", "failed"]), handoff }).strict()
  .refine((v) => bytes(v) <= 65536);
export const BenchCoordinatorCompletion = z.object({ source: BenchCoordinatorPrepared, service, task,
  source_request_sha256: sha, source_receipt_sha256: sha }).strict()
  .refine((c) => {
    const b = c.source.binding; const i = b.identity; const t = c.task.binding; const s = c.service;
    const coordinator = b.members.find((m) => m.name === c.source.checkpoint_repository);
    return c.source_request_sha256 === c.source.source_request_sha256 &&
      s.request_id === c.source.request_id && s.request_sha256 === b.request_sha256 && s.body_sha256 === b.body_sha256 &&
      t.board_id === i.board_id && t.card_id === i.card_id && t.run_id === i.run_id && t.epoch === i.epoch &&
      sorted(s.checkpoints) && s.checkpoints.length === b.sources.length && s.checkpoints.every((m, n) => {
        const old = b.sources[n]; const known = b.members[n];
        return old?.name === m.name && old.repository_sha256 === m.repository_sha256 && old.task_ref === m.task_ref &&
          m.commit.length === (known?.object_format === "sha1" ? 40 : 64);
      }) && s.seal_commit.length === (coordinator?.object_format === "sha1" ? 40 : 64);
  });
export type BenchCoordinatorCompletion = z.infer<typeof BenchCoordinatorCompletion>;
const receipt = z.object({ run_id: product("run"), epoch: integer.min(1), source_digest: sha, admitted_at: integer }).strict();
const selectors = { tenant_id: id, board_id: product("brd"), station_id: id };
const fixed = { version: z.literal(BENCH_COORDINATOR_VERSION) };
const owned = { identity: BenchCoordinatorIdentity, target: BenchCoordinatorTarget };
const requestUnion = z.discriminatedUnion("operation", [
  z.object({ ...fixed, operation: z.literal("ready"), ...selectors }).strict(),
  z.object({ ...fixed, operation: z.literal("prepare"), ...owned, task: z.object({
    profile_id: id, prompt: z.string().min(1).max(65536).refine(scalar),
    timeout_seconds: integer.min(1).max(3600), repository_name: name.optional(),
  }).strict() }).strict(),
  z.object({ ...fixed, operation: z.literal("execute"), ...owned, binding_sha256: sha, source_receipt: receipt }).strict(),
  z.object({ ...fixed, operation: z.literal("status"), ...owned }).strict(),
]);
const matched = (i: z.infer<typeof BenchCoordinatorIdentity>, t: z.infer<typeof BenchCoordinatorTarget>) =>
  i.tenant_id === t.tenant_id && i.board_id === t.board_id && i.agent_id === t.agent_id &&
  i.station_id === t.station_id && i.node_id === t.node_id;
export const BenchCoordinatorRequest = requestUnion.refine((r) => r.operation === "ready" ||
  matched(r.identity, r.target) && (r.operation !== "execute" ||
    r.source_receipt.run_id === r.identity.run_id && r.source_receipt.epoch === r.identity.epoch))
  .refine((r) => bytes(r) <= BENCH_COORDINATOR_MAX_REQUEST);
export type BenchCoordinatorRequest = z.infer<typeof BenchCoordinatorRequest>;

/** Node-authenticated fresh authority lookup; the URL and credential are installation-owned. */
export const BENCH_COORDINATOR_CURRENT_VERSION = "agentpod.bench-coordinator-current.v1";
export const BenchCoordinatorCurrentRequest = z.object({
  version: z.literal(BENCH_COORDINATOR_CURRENT_VERSION), phase: z.enum(["prepare", "execute", "observe"]),
  nonce: bid, identity: BenchCoordinatorIdentity, target: BenchCoordinatorTarget, profile_id: id,
  prepare_request_sha256: sha,
  execute_request_sha256: sha.optional(),
  binding_sha256: sha.optional(), source_digest: sha.optional(),
}).strict().refine((r) => matched(r.identity, r.target) &&
  (r.source_digest === undefined || r.binding_sha256 !== undefined) &&
  (r.phase !== "execute" || r.binding_sha256 !== undefined && r.source_digest !== undefined && r.execute_request_sha256 !== undefined))
  .refine((r) => bytes(r) <= BENCH_COORDINATOR_MAX_REQUEST);
export type BenchCoordinatorCurrentRequest = z.infer<typeof BenchCoordinatorCurrentRequest>;
const currentBase = { version: z.literal(BENCH_COORDINATOR_CURRENT_VERSION), nonce: bid,
  request_sha256: sha, issued_at_ms: integer, expires_at_ms: integer };
export const BenchCoordinatorCurrentResponse = z.discriminatedUnion("decision", [
  z.object({ ...currentBase, decision: z.literal("current") }).strict(),
  z.object({ ...currentBase, decision: z.literal("refused"),
    code: z.enum(["unauthorized", "stale_owner", "unavailable", "pending", "invalid"]) }).strict(),
]).refine((r) => r.expires_at_ms > r.issued_at_ms && r.expires_at_ms - r.issued_at_ms <= 5000);
export type BenchCoordinatorCurrentResponse = z.infer<typeof BenchCoordinatorCurrentResponse>;
const pending = z.object({ ...fixed, operation: z.enum(["prepare", "execute", "status"]), ...owned,
  state: z.enum(["unknown", "pending", "superseded"]) }).strict();
const prepared = z.object({ ...fixed, operation: z.enum(["prepare", "status"]), ...owned,
  state: z.literal("prepared"), source: BenchCoordinatorPrepared }).strict();
const completed = z.object({ ...fixed, operation: z.enum(["execute", "status"]), ...owned,
  state: z.literal("completed"), completion: BenchCoordinatorCompletion }).strict();
export const BenchCoordinatorResponse = z.union([
  z.object({ ...fixed, operation: z.literal("ready"), state: z.literal("available"), target: BenchCoordinatorTarget }).strict(),
  z.object({ ...fixed, operation: z.literal("ready"), state: z.literal("unavailable"),
    code: z.enum(["disabled", "unsupported", "offline", "unverified"]) }).strict(),
  z.object({ ...fixed, operation: z.enum(["ready", "prepare", "execute", "status"]), state: z.literal("refused"),
    code: z.enum(["invalid", "unsupported", "unavailable", "unauthorized", "stale_owner", "conflict", "pending", "verification_failed"]) }).strict(),
  pending, prepared, completed,
]).refine((r) => {
  if (!("identity" in r)) return true;
  if (!matched(r.identity, r.target)) return false;
  const source = r.state === "prepared" ? r.source : r.state === "completed" ? r.completion.source : undefined;
  return source === undefined || same(source.binding.identity, r.identity) && source.binding.host_id === r.target.host_id &&
    source.binding.worker_sha256 === r.target.worker_sha256;
}).refine((r) => bytes(r) <= BENCH_COORDINATOR_MAX_RESPONSE);
export type BenchCoordinatorResponse = z.infer<typeof BenchCoordinatorResponse>;

/** Only ASCII observations occur in this typed binding; declared field order matches the Go observation. */
export async function benchCoordinatorBindingDigest(value: unknown): Promise<string> {
  const b = BenchCoordinatorSourceBinding.parse(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(b)));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}
async function checkResponse(value: unknown, request: unknown): Promise<BenchCoordinatorResponse> {
  const r = BenchCoordinatorResponse.parse(value); const sent = BenchCoordinatorRequest.parse(request);
  if (r.operation !== sent.operation) throw new Error("Coordinator response refused");
  if (sent.operation === "ready") {
    if (r.state === "available" && (r.target.tenant_id !== sent.tenant_id || r.target.board_id !== sent.board_id ||
      r.target.station_id !== sent.station_id)) throw new Error("Coordinator response refused");
  } else if ("identity" in r && (!same(r.identity, sent.identity) || !same(r.target, sent.target)))
    throw new Error("Coordinator response refused");
  const p = r.state === "prepared" ? r.source : r.state === "completed" ? r.completion.source : undefined;
  if (p && await benchCoordinatorBindingDigest(p.binding) !== p.binding_sha256) throw new Error("Coordinator response refused");
  if (sent.operation === "execute" && p?.binding_sha256 !== undefined && p.binding_sha256 !== sent.binding_sha256)
    throw new Error("Coordinator response refused");
  return r;
}

/** Strict UTF-8 JSON: no duplicate keys, nulls, invalid scalars or ambiguous integer lexemes. */
function read(raw: Uint8Array, limit: number): unknown {
  if (raw.byteLength > limit) throw new Error("Coordinator data refused");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  let pos = 0;
  function ws() { while (/[ \n\r\t]/.test(text[pos] ?? "") && pos < text.length) pos++; }
  function string(): string {
    const start = pos++;
    while (pos < text.length) {
      if (text[pos] === "\\") { pos += 2; continue; }
      if (text[pos++] === '"') {
        const result: unknown = JSON.parse(text.slice(start, pos));
        if (typeof result !== "string" || !scalar(result)) throw new Error("Coordinator data refused");
        return result;
      }
    }
    throw new Error("Coordinator data refused");
  }
  function value(depth: number): void {
    if (depth > 64) throw new Error("Coordinator data refused");
    ws(); const c = text[pos];
    if (c === '"') { string(); return; }
    if (c === "{" || c === "[") {
      const object = c === "{"; const end = object ? "}" : "]"; const keys = new Set<string>();
      pos++; ws();
      if (text[pos] === end) { pos++; return; }
      while (pos < text.length) {
        if (object) {
          if (text[pos] !== '"') throw new Error("Coordinator data refused");
          const objectKey = string(); if (keys.has(objectKey)) throw new Error("Coordinator data refused"); keys.add(objectKey);
          ws(); if (text[pos++] !== ":") throw new Error("Coordinator data refused");
        }
        value(depth + 1); ws();
        if (text[pos] === end) { pos++; return; }
        if (text[pos++] !== ",") throw new Error("Coordinator data refused"); ws();
      }
      throw new Error("Coordinator data refused");
    }
    const atom = /^(true|false|0|[1-9][0-9]*)/.exec(text.slice(pos))?.[0];
    if (!atom || (atom !== "true" && atom !== "false" && !Number.isSafeInteger(Number(atom))))
      throw new Error("Coordinator data refused");
    pos += atom.length;
  }
  value(0); ws(); if (pos !== text.length) throw new Error("Coordinator data refused");
  return JSON.parse(text);
}
export function parseBenchCoordinatorRequest(raw: Uint8Array): BenchCoordinatorRequest {
  try { return BenchCoordinatorRequest.parse(read(raw, BENCH_COORDINATOR_MAX_REQUEST)); }
  catch { throw new Error("Coordinator request refused"); }
}
export async function parseBenchCoordinatorResponse(raw: Uint8Array, request: unknown): Promise<BenchCoordinatorResponse> {
  try { return await checkResponse(read(raw, BENCH_COORDINATOR_MAX_RESPONSE), request); }
  catch { throw new Error("Coordinator response refused"); }
}

/** A closed refusal never includes untrusted wire text or private adapter errors. */
export async function checkBenchCoordinatorResponse(value: unknown, request: unknown): Promise<BenchCoordinatorResponse> {
  try { return await checkResponse(value, request); }
  catch { throw new Error("Coordinator response refused"); }
}

export function parseBenchCoordinatorCurrentRequest(raw: Uint8Array): BenchCoordinatorCurrentRequest {
  try { return BenchCoordinatorCurrentRequest.parse(read(raw, BENCH_COORDINATOR_MAX_REQUEST)); }
  catch { throw new Error("Coordinator current request refused"); }
}
export async function parseBenchCoordinatorCurrentResponse(raw: Uint8Array, requestRaw: Uint8Array,
  nowMs = Date.now()): Promise<BenchCoordinatorCurrentResponse> {
  try {
    const request = parseBenchCoordinatorCurrentRequest(requestRaw);
    const response = BenchCoordinatorCurrentResponse.parse(read(raw, 4096));
    const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(requestRaw));
    const expected = Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, "0")).join("");
    if (!Number.isSafeInteger(nowMs) || response.nonce !== request.nonce || response.request_sha256 !== expected ||
      response.issued_at_ms > nowMs || response.expires_at_ms <= nowMs)
      throw new Error("Coordinator current response refused");
    return response;
  } catch { throw new Error("Coordinator current response refused"); }
}
