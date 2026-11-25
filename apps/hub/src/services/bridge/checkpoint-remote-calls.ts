/**
 * A remote bench stage's node calls, and how long each is waited on.
 *
 * - The bench host's node (`target.node_id`) takes the coordinator's `attach` and `finish`, gated on
 *   current authority before and after, as execute is. Their bounds are NODE_CALL_TIMEOUT_MS's.
 * - The agent's node (`executor.nodeId`) takes `bench.identity.ensure`, `bench.remote.attach`,
 *   `bench.remote.detach` and `bench.remote.status` (contract bench-remote.ts). Each answers what it
 *   did, or `{state: "refused", code, message}` when it changed nothing.
 *
 * A wait that ends is never a refusal: it parks the phase (`remote.<step>.unreachable`), and the next
 * pass asks again. Every one of these calls is safe to repeat.
 */
import { BENCH_COORDINATOR_VERB, BENCH_IDENTITY_ENSURE_VERB, BENCH_REMOTE_ATTACH_VERB, BENCH_REMOTE_DETACH_VERB,
  BENCH_REMOTE_STATUS_VERB, BenchCoordinatorRequest, BenchIdentityEnsureReply, BenchRemoteAttachReply, BenchRemoteDetachReply,
  BenchRemoteStatusReply, parseBenchCoordinatorResponse, type BenchCoordinatorRemoteCredential,
  type BenchCoordinatorResponse, type BenchRemoteRefused } from "@agentpod/contract";
import type { z } from "zod";
import type { request as nodeRequest } from "../broker";
import { parseCheckpointJSON } from "./checkpoint-json";
import { nodeCallTimeoutMs } from "./checkpoint-node-call";
import { CheckpointRefused } from "./checkpoint-profile";
import { noteCheckpoint } from "./checkpoint-log";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";

const encode = (raw: string) => new TextEncoder().encode(raw);

/** How long the Hub waits on each verb on the agent's node. Each is a local file or key operation there. */
export const AGENT_NODE_CALL_TIMEOUT_MS = { ensure: 15_000, attach: 30_000, detach: 30_000, status: 10_000 } as const;

/** The effects a remote phase's node calls need: the drive's own authority check and broker. */
export interface RemoteCallDeps {
  authority(attempt: RetainedCheckpointAttempt): Promise<void>;
  request: typeof nodeRequest;
}

/**
 * One coordinator call to the bench host's node with the exact retained bytes. Authority is read
 * before and after; the reply is bounded, parsed strictly and matched to the request.
 */
export async function benchCall(attempt: RetainedCheckpointAttempt, raw: string, deps: RemoteCallDeps): Promise<BenchCoordinatorResponse> {
  const sent = BenchCoordinatorRequest.parse(parseCheckpointJSON(encode(raw)));
  if (sent.operation !== "attach" && sent.operation !== "finish") throw new CheckpointRefused("invalid", "remote.state");
  await deps.authority(attempt);
  const result = await deps.request(attempt.profile.target.node_id, BENCH_COORDINATOR_VERB, sent,
    { timeoutMs: nodeCallTimeoutMs(sent.operation) });
  if (!result.ok) throw new CheckpointRefused("uncertain", `remote.${sent.operation}.unreachable`, new Error(result.error ?? "no error"));
  const serialized = JSON.stringify(result.data);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 262144) throw new CheckpointRefused("source", "node.reply.size");
  const response = await parseBenchCoordinatorResponse(encode(serialized), sent);
  await deps.authority(attempt);
  return response;
}

type AgentStep = keyof typeof AGENT_NODE_CALL_TIMEOUT_MS;
const VERBS: Record<AgentStep, string> = { ensure: BENCH_IDENTITY_ENSURE_VERB, attach: BENCH_REMOTE_ATTACH_VERB,
  detach: BENCH_REMOTE_DETACH_VERB, status: BENCH_REMOTE_STATUS_VERB };

async function agentCall<T>(nodeId: string, step: AgentStep, params: Record<string, unknown>, schema: z.ZodType<T>,
  deps: Pick<RemoteCallDeps, "request">): Promise<T> {
  const result = await deps.request(nodeId, VERBS[step], params, { timeoutMs: AGENT_NODE_CALL_TIMEOUT_MS[step] });
  if (!result.ok) throw new CheckpointRefused("uncertain", `remote.agent_${step}.unreachable`, new Error(result.error ?? "no error"));
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new CheckpointRefused("source", `remote.agent_${step}.reply`, parsed.error);
  return parsed.data;
}

const isRefused = (reply: object): reply is BenchRemoteRefused => "state" in reply && reply.state === "refused";
export type AgentReply<T> = { ok: T } | { refused: BenchRemoteRefused };

/** The station's bench public key, generated on the agent's node the first time. The private key stays there. */
export async function ensureIdentity(nodeId: string, station: { stationId: string; stationKey: string },
  deps: Pick<RemoteCallDeps, "request">): Promise<AgentReply<string>> {
  const reply = await agentCall(nodeId, "ensure", { stationId: station.stationId, stationKey: station.stationKey }, BenchIdentityEnsureReply, deps);
  return isRefused(reply) ? { refused: reply } : { ok: reply.publicKey };
}

/**
 * Point the station's Hermes profile at the bench, or renew its certificate (the same attempt again).
 * Only the inner credential the bench host's node relayed is passed: the agent's node decodes it strictly.
 */
export async function attachAgent(nodeId: string, input: { stationId: string; stationKey: string; attemptId: string;
  credential: BenchCoordinatorRemoteCredential }, deps: Pick<RemoteCallDeps, "request">): Promise<AgentReply<{ validBefore: string }>> {
  const reply = await agentCall(nodeId, "attach", { stationId: input.stationId, stationKey: input.stationKey,
    attemptId: input.attemptId, credential: input.credential }, BenchRemoteAttachReply, deps);
  return isRefused(reply) ? { refused: reply } : { ok: { validBefore: reply.validBefore } };
}

/** Restore the station's own terminal. `absent` is an answer too: nothing was attached. */
export async function detachAgent(nodeId: string, input: { stationId: string; attemptId: string },
  deps: Pick<RemoteCallDeps, "request">): Promise<AgentReply<"detached" | "absent" | "terminal_changed">> {
  const reply = await agentCall(nodeId, "detach", { stationId: input.stationId, attemptId: input.attemptId }, BenchRemoteDetachReply, deps);
  return isRefused(reply) ? { refused: reply } : { ok: reply.state };
}

/** Whether the agent's node holds this attempt's attachment now. Any failure to ask is "no". */
export async function agentAttachedTo(nodeId: string, stationId: string, attemptId: string,
  deps: Pick<RemoteCallDeps, "request">): Promise<boolean> {
  try {
    const reply = await agentCall(nodeId, "status", { stationId }, BenchRemoteStatusReply, deps);
    return !isRefused(reply) && reply.attemptId === attemptId;
  } catch (error) {
    noteCheckpoint("remote", "remote.agent_status", { nodeId, attemptId }, error);
    return false;
  }
}
