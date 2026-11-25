/**
 * A remote bench stage's retained state (the attempt row's `remote` cell), and the Hub's current
 * decision for the bench host's node's `attach` and `finish`. Apart from checkpoint-remote.ts so the
 * current decision can read it without importing the phases that call it.
 *
 * The state holds where the bench is and when its certificate expires: never the certificate, a
 * private key or a lease token. The agent's public key is kept as its fingerprint; the attach request
 * that carries it is kept as its SHA-256, which is what the node's current check names.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseBenchCoordinatorRequest } from "@agentpod/contract";
import { canonicalCheckpoint, parseCheckpointJSON } from "./checkpoint-json";
import { CheckpointRefused, isRemoteProfile } from "./checkpoint-profile";
import type { RetainedCheckpointAttempt } from "./checkpoint-ledger";

const encode = (raw: string) => new TextEncoder().encode(raw);
const sha = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);

export interface RemoteState {
  /** `SHA256:<base64>` of the agent's public key: the same key renews; another is refused. */
  publicKeyFingerprint: string;
  /** SHA-256 of the exact attach request bytes. A renewal sends the same bytes. */
  attachRequestSHA256: string;
  /** The SSH user, `b-<bench id>`, as SuperBench issued it. Empty until attached. */
  user: string;
  /** The bench's SSH door. Empty until attached. */
  address: string;
  /** The workspace root on the bench: the agent's working directory. Empty until attached. */
  workingDirectory: string;
  /** When the agent's certificate expires (RFC 3339). Empty until attached. */
  validBefore: string;
  /**
   * Written before `bench.remote.attach` is sent (write-ahead, as the agent's node journals its own):
   * from here the agent's node may have pointed the station at the bench, so it is detached before
   * the station is free, even when the attach's reply never came.
   */
  agentAttachSent: boolean;
  /** The agent's node answered that the station points at the bench. */
  attached: boolean;
  /** The agent's node has restored the station's own terminal. */
  detached: boolean;
  /** How many times the agent was told to commit a dirty tree (at most REMOTE_DIRTY_RETRIES). */
  dirtyTries: number;
  /** A hub restart's resumed turn has been started (checkpoint-remote recovery). */
  resumed: boolean;
  /** In `finish_pending`: the exact finish request bytes, the agent's handoff inside. */
  finishRequest?: string;
  /**
   * After a dirty finish, until the agent is prompted again: what it is told. The finish fenced its
   * sessions and SuperBench retired the certificate, so the agent is attached again and given a
   * fresh session first.
   */
  retryPrompt?: string;
  /** The summary of the agent's earlier turns, kept across dirty retries and joined with the last one. */
  summary?: string;
  /**
   * When the agent's first turn started (RFC 3339): the stage's turn bound runs from here, across dirty
   * retries and hub restarts alike.
   */
  turnStartedAt?: string;
}

const schema = z.object({ publicKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{1,128}(?![\s\S])/), attachRequestSHA256: sha,
  user: z.string().max(64), address: z.string().max(300), workingDirectory: z.string().max(4096), validBefore: z.string().max(40),
  agentAttachSent: z.boolean(), attached: z.boolean(), detached: z.boolean(), dirtyTries: z.number().int().min(0).max(16), resumed: z.boolean(),
  finishRequest: z.string().min(1).max(65536).optional(), retryPrompt: z.string().min(1).max(2048).optional(),
  summary: z.string().max(8192).optional(), turnStartedAt: z.string().max(40).optional() }).strict();

/**
 * Whether the agent's node may still point the station at the bench: an attach was sent and no
 * detach has been confirmed. Such a station is busy whatever the attempt's phase.
 */
export const mayBeAttached = (state: RemoteState | undefined): boolean => !!state && (state.agentAttachSent || state.attached) && !state.detached;

/** The retained state, or undefined for a row that holds none yet. A cell that does not parse is refused. */
export function parseRemoteState(raw: string | null): RemoteState | undefined {
  if (raw === null) return undefined;
  const parsed = schema.safeParse(parseCheckpointJSON(encode(raw)));
  if (!parsed.success) throw new CheckpointRefused("source", "remote.state");
  return parsed.data;
}

/** The state as it is stored: canonical, and checked against the schema it is read with. */
export function canonicalRemoteState(state: RemoteState): string {
  return canonicalCheckpoint(schema.parse(state));
}

/** `SHA256:<base64, no padding>` of an OpenSSH public key line's key blob, as `ssh-keygen -l` prints it. */
export function publicKeyFingerprint(line: string): string {
  const blob = line.trim().split(/\s+/)[1];
  if (!blob || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) throw new CheckpointRefused("invalid", "remote.identity.key");
  return "SHA256:" + createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "");
}

const hash = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");

/**
 * Whether the bench host's node may `attach` or `finish` this attempt now, as rigorously as execute:
 * the caller has already matched the request to the attempt's identity, target, profile and prepare,
 * and its binding to the retained preparation. Here: the stage is remote, the attempt is in the phase
 * that sends this operation, and the request's own bytes are the ones the Hub retained for it.
 * Undefined means current; `pending` means the Hub has not (yet) retained these bytes for this phase,
 * which never lets the node issue a certificate or finish. A one-shot attempt never attaches.
 */
export function remoteDecision(attempt: RetainedCheckpointAttempt, phase: "attach" | "finish", requestSHA256: string | undefined,
  bindingSHA256: string): "pending" | "invalid" | undefined {
  if (!isRemoteProfile(attempt.profile)) return "invalid";
  const state = parseRemoteState(attempt.row.remote);
  if (!state || requestSHA256 === undefined) return "pending";
  if (phase === "attach") {
    // Attach first, then each renewal while working, with the same bytes.
    if (attempt.row.phase !== "attach_pending" && attempt.row.phase !== "working") return "pending";
    return state.attachRequestSHA256 === requestSHA256 ? undefined : "pending";
  }
  if (attempt.row.phase !== "finish_pending" || !state.finishRequest || hash(state.finishRequest) !== requestSHA256) return "pending";
  const finish = parseBenchCoordinatorRequest(encode(state.finishRequest));
  if (finish.operation !== "finish" || finish.binding_sha256 !== bindingSHA256 ||
    canonicalCheckpoint(finish.identity) !== canonicalCheckpoint(attempt.request.identity) ||
    canonicalCheckpoint(finish.target) !== canonicalCheckpoint(attempt.request.target)) return "pending";
  return undefined;
}
