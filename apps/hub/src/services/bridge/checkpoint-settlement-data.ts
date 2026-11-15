/** Proposed T37 service data; no authority is derived from validation. */
import { z } from "zod";
import { canonicalCheckpoint, parseCheckpointJSON } from "./checkpoint-json";
import { CheckpointRefused } from "./checkpoint-profile";
import { createHash } from "node:crypto";

const sha = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}(?![\s\S])/);
const product = (prefix: string) => z.string().max(80).regex(new RegExp(`^${prefix}_[A-Za-z0-9]{6,}(?![\\s\\S])`));
const name = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}(?![\s\S])/);
const bid = z.string().regex(/^[a-f0-9]{32}(?![\s\S])/);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/);
const member = z.object({ name, provider: z.enum(["forge", "github"]),
  repository: z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/),
  branch: z.string().max(255).regex(/^card\/card_[A-Za-z0-9]{6,}(?![\s\S])/),
  objectFormat: z.enum(["sha1", "sha256"]), commit }).strict();
const handoff = z.record(z.string(), z.string().max(8192)).refine((value) => Object.keys(value).length <= 64 &&
  Object.keys(value).every((field) => /^[A-Za-z][A-Za-z0-9_-]{0,79}(?![\s\S])/.test(field)));
export const checkpointSettlementSchema = z.object({ version: z.literal("superpipeline.checkpoint-settlement.v1"),
  checkpoint: z.object({ version: z.literal("superpipeline.run-checkpoint.v1"), settlementId: key,
    binding: z.object({ boardId: product("brd"), cardId: product("card"), stageKey: key, runId: product("run"),
      leaseEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), agentId: product("agt"),
      stationId: z.string().min(1).max(128), nodeId: z.string().min(1).max(128), attemptId: key }).strict(),
    policyDigest: sha, disposition: z.enum(["changed", "unchanged"]),
    start: z.array(z.object({ name, commit }).strict()).min(1).max(32),
    checkpoint: z.object({ protocol: z.literal("superbench.v2"), key, benchId: bid, requestId: key,
      generationId: bid, seal: commit, manifestSha256: sha, members: z.array(member).min(1).max(32), checkpointRepository: name }).strict(),
    execution: z.object({ id: bid, exitCode: z.literal(0) }).strict(), workerResultSha256: sha,
    sourceReceiptSha256: sha, sourceRequestSha256: sha }).strict(), handoff, outcome: z.literal("pass") }).strict();
export type CheckpointSettlement = z.infer<typeof checkpointSettlementSchema>;

export const checkpointReceiptSchema = z.object({ version: z.literal("superpipeline.run-checkpoint-receipt.v1"),
 settlementId:key,requestDigest:sha,reportDigest:sha,reportedBy:product("prn"),runId:product("run"),
 leaseEpoch:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),recordedAt:z.string().max(35).datetime({offset:true}),
 checkpoint:checkpointSettlementSchema.shape.checkpoint.shape.checkpoint }).strict();
export type CheckpointReceipt = z.infer<typeof checkpointReceiptSchema>;
const hash = (value: unknown) => createHash("sha256").update(canonicalCheckpoint(value), "utf8").digest("hex");
export function checkedCheckpointReceipt(raw:Uint8Array,body:string,reporter:string):CheckpointReceipt {
 try {
  const submitted=checkpointSettlementSchema.parse(parseCheckpointJSON(new TextEncoder().encode(body)));
  const receipt=checkpointReceiptSchema.parse(parseCheckpointJSON(raw));
  const report=submitted.checkpoint;
  if(receipt.requestDigest!==hash(submitted)||receipt.reportDigest!==hash(report)||receipt.reportedBy!==reporter||
   receipt.settlementId!==report.settlementId||receipt.runId!==report.binding.runId||receipt.leaseEpoch!==report.binding.leaseEpoch||
   canonicalCheckpoint(receipt.checkpoint)!==canonicalCheckpoint(report.checkpoint))throw new CheckpointRefused("source");
  return receipt;
 } catch { throw new CheckpointRefused("source"); }
}
