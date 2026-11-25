/**
 * Remote bench verbs on the agent's node (Go `internal/benchremote`): a Hermes station works in a
 * card's bench through the bench's SSH door.
 *
 * - `bench.identity.ensure` returns the station's bench public key, generated on first ask. The
 *   private key never leaves the node and its path is never returned.
 * - `bench.remote.attach` takes the certificate SuperBench issued (relayed from the bench host's
 *   node) and points the station's Hermes profile at the bench. The same `attemptId` again renews:
 *   only the certificate is rewritten.
 * - `bench.remote.detach` restores the profile exactly; `bench.remote.status` reports the live
 *   attachment.
 *
 * Neither attach nor detach restarts the gateway. An open ACP session keeps its backend; the hub
 * opens a new session after each. Every request is decoded strictly: an unknown field is refused.
 */
import { z } from "zod";

export const BENCH_REMOTE_ATTACH_CAPABILITY = "bench.remote.attach";
export const BENCH_IDENTITY_ENSURE_VERB = "bench.identity.ensure";
export const BENCH_REMOTE_ATTACH_VERB = "bench.remote.attach";
export const BENCH_REMOTE_DETACH_VERB = "bench.remote.detach";
export const BENCH_REMOTE_STATUS_VERB = "bench.remote.status";

const stationId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).refine((s) => s !== "." && s !== "..");
const attemptId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const rfc3339 = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/);

/** The certificate reply SuperBench issues. Public material only: never the lease token. */
export const BenchRemoteCredential = z.strictObject({
  certificate: z.string().regex(/^(ssh-ed25519|ecdsa-sha2-nistp256)-cert-v01@openssh\.com /),
  user: z.string().regex(/^b-[a-f0-9]{32}$/),
  address: z.string().min(1),
  host_key: z.string().min(1),
  host_key_fingerprint: z.string().min(1),
  lease_id: z.string().min(1),
  generation: z.number().int().nonnegative(),
  valid_before: rfc3339,
  working_directory: z.string().startsWith("/"),
});
export type BenchRemoteCredential = z.infer<typeof BenchRemoteCredential>;

/** Why a verb changed nothing (Go `benchattach.Code*`, plus `unavailable` for a node-side failure). */
export const BenchRemoteRefusalCode = z.enum([
  "harness_unsupported", "terminal_in_use", "attached_elsewhere", "credential_files", "invalid", "unavailable",
]);
export type BenchRemoteRefusalCode = z.infer<typeof BenchRemoteRefusalCode>;

export const BenchRemoteRefused = z.object({ state: z.literal("refused"), code: BenchRemoteRefusalCode, message: z.string() });
export type BenchRemoteRefused = z.infer<typeof BenchRemoteRefused>;

export const BenchIdentityEnsureRequest = z.strictObject({ stationId, stationKey: z.string().min(1) });
export type BenchIdentityEnsureRequest = z.infer<typeof BenchIdentityEnsureRequest>;
export const BenchIdentityEnsureReply = z.union([z.object({ publicKey: z.string().startsWith("ssh-ed25519 ") }), BenchRemoteRefused]);
export type BenchIdentityEnsureReply = z.infer<typeof BenchIdentityEnsureReply>;

export const BenchRemoteAttachRequest = z.strictObject({
  stationId, stationKey: z.string().min(1), attemptId, credential: BenchRemoteCredential,
});
export type BenchRemoteAttachRequest = z.infer<typeof BenchRemoteAttachRequest>;
export const BenchRemoteAttachReply = z.union([
  z.object({ state: z.literal("attached"), validBefore: rfc3339 }), BenchRemoteRefused,
]);
export type BenchRemoteAttachReply = z.infer<typeof BenchRemoteAttachReply>;

export const BenchRemoteDetachRequest = z.strictObject({ stationId, attemptId });
export type BenchRemoteDetachRequest = z.infer<typeof BenchRemoteDetachRequest>;
/** `terminal_changed`: someone else rewrote the profile's terminal section since; theirs stands. */
export const BenchRemoteDetachReply = z.union([
  z.object({ state: z.enum(["detached", "absent", "terminal_changed"]) }), BenchRemoteRefused,
]);
export type BenchRemoteDetachReply = z.infer<typeof BenchRemoteDetachReply>;

export const BenchRemoteStatusRequest = z.strictObject({ stationId });
export type BenchRemoteStatusRequest = z.infer<typeof BenchRemoteStatusRequest>;
/** Both fields absent: nothing is attached. */
export const BenchRemoteStatusReply = z.union([
  z.strictObject({ attemptId: attemptId.optional(), validBefore: rfc3339.optional() }), BenchRemoteRefused,
]);
export type BenchRemoteStatusReply = z.infer<typeof BenchRemoteStatusReply>;
