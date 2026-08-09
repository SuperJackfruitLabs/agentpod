import { z } from "zod";
export const Capability = z.enum(["inventory","health","logs","fs.read","fs.write","terminal","lifecycle","cleanup","acp"]);
export type Capability = z.infer<typeof Capability>;
export const StationKind = z.enum(["composite","leaf"]);
export const Station = z.object({
  key: z.string().min(1), harness: z.string().min(1), kind: StationKind,
  displayName: z.string(), parentKey: z.string().nullable(),
  workspacePath: z.string().nullable(), capabilities: z.array(Capability),
  matrixId: z.string().nullable().optional(),
});
export type Station = z.infer<typeof Station>;
export const DetectedStation = Station.extend({ adopted: z.boolean() });
export type DetectedStation = z.infer<typeof DetectedStation>;
export const StationHealth = z.object({
  running: z.boolean(), pid: z.number().nullable(), cpuPct: z.number().nullable(),
  memBytes: z.number().nullable(), diskBytes: z.number().nullable(),
  uptimeSec: z.number().nullable(), lastActivity: z.string().nullable(), note: z.string().nullable(),
});
export type StationHealth = z.infer<typeof StationHealth>;
export const FsEntry = z.object({
  name: z.string(), path: z.string(), type: z.enum(["file","dir","symlink"]),
  size: z.number().nullable(), modified: z.string().nullable(),
});
export type FsEntry = z.infer<typeof FsEntry>;
