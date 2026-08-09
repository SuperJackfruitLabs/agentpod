import { z } from "zod";
import { Station, StationHealth, FsEntry } from "./station";

export const RequestMsg = z.object({ type: z.literal("req"), id: z.string(), verb: z.string(), params: z.unknown() });
export const ResponseMsg = z.object({ type: z.literal("res"), id: z.string(), ok: z.boolean(), data: z.unknown().optional(), error: z.string().optional() });
export const StreamMsg = z.object({ type: z.literal("stream"), id: z.string(), seq: z.number().int(), chunk: z.string().nullable(), eof: z.boolean(), enc: z.enum(["utf8","base64"]).optional() });
export const CancelMsg = z.object({ type: z.literal("cancel"), id: z.string() });

export type RequestMsg = z.infer<typeof RequestMsg>;
export type ResponseMsg = z.infer<typeof ResponseMsg>;
export type StreamMsg = z.infer<typeof StreamMsg>;

/**
 * Keystroke/data frame sent hub → node over the gateway socket.
 * `id` is dual-purpose depending on which handler owns it:
 *  - terminal input frames key `id` by the attach-request id (term.attach's id).
 *  - ACP input frames key `id` by the ACP session id — the node's acpHandler
 *    routes incoming input by session id, not by attach-request id.
 */
export const InputMsg = z.object({ type: z.literal("input"), id: z.string(), data: z.string() });
export const ResizeMsg = z.object({ type: z.literal("resize"), id: z.string(), cols: z.number().int(), rows: z.number().int() });
export type InputMsg = z.infer<typeof InputMsg>;
export type ResizeMsg = z.infer<typeof ResizeMsg>;

export const VERB_PARAMS = {
  "detect": z.object({}),
  "health": z.object({ key: z.string() }),
  "fs.list": z.object({ key: z.string(), path: z.string() }),
  "fs.read": z.object({ key: z.string(), path: z.string(), maxBytes: z.number().int().optional() }),
  "logs.tail": z.object({ key: z.string(), follow: z.boolean() }),
  "fs.write": z.object({ key: z.string(), path: z.string(), content: z.string(), encoding: z.enum(["utf8","base64"]), backup: z.boolean().optional() }),
  "fs.mkdir": z.object({ key: z.string(), path: z.string() }),
  "fs.move":  z.object({ key: z.string(), from: z.string(), to: z.string() }),
  "fs.delete":z.object({ key: z.string(), path: z.string(), recursive: z.boolean().optional() }),
  "lifecycle":z.object({ key: z.string(), action: z.enum(["start","stop","restart"]) }),
  "cleanup.plan":  z.object({ key: z.string() }),
  "cleanup.apply": z.object({ key: z.string(), paths: z.array(z.string()) }),
  "term.open":   z.object({ key: z.string(), cols: z.number().int(), rows: z.number().int() }),
  "term.attach": z.object({ sessionId: z.string() }),
  "term.close":  z.object({ sessionId: z.string() }),
  "acp.open":   z.object({ key: z.string() }),
  "acp.attach": z.object({ sessionId: z.string() }),
  "acp.close":  z.object({ sessionId: z.string() }),
} as const;

// VERB_RESULTS describes what the NODE returns on each verb.
// NOTE: "detect" returns plain Station[] (no adopted field) — the hub
// annotates adopted:true/false from its DB before forwarding to clients.
export const VERB_RESULTS = {
  "detect": z.array(Station),
  "health": StationHealth,
  "fs.list": z.array(FsEntry),
  "fs.read": z.object({ content: z.string(), encoding: z.enum(["utf8","base64"]), truncated: z.boolean() }),
  "fs.write": z.object({ bytesWritten: z.number().int(), backupPath: z.string().nullable().optional() }),
  "fs.mkdir": z.object({ ok: z.boolean() }),
  "fs.move":  z.object({ ok: z.boolean() }),
  "fs.delete":z.object({ ok: z.boolean() }),
  "lifecycle":StationHealth,
  "cleanup.plan":  z.object({ items: z.array(z.object({ path: z.string(), size: z.number().int(), kind: z.string() })), totalBytes: z.number().int() }),
  "cleanup.apply": z.object({ removedBytes: z.number().int() }),
  "term.open":  z.object({ sessionId: z.string() }),
  "term.close": z.object({ ok: z.boolean() }),
  // term.attach streams; no entry needed.
  "acp.open":  z.object({ sessionId: z.string() }),
  "acp.close": z.object({ ok: z.boolean() }),
  // acp.attach streams; no entry needed (same as term.attach).
} as const;
