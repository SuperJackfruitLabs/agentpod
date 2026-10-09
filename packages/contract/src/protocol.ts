import { z } from "zod";
import { Station, StationHealth, FsEntry } from "./station";
import { ChangesetStatus, ChangesetDiff, ChangesetDiffSide } from "./changeset";
import { PostureReport } from "./posture";
import { SkillInventory, SkillInventoryParams } from "./skills";
import { SkillPlanParams, SkillApplyParams, SkillOperationParams, SkillVerifyParams, SkillRetentionParams, SkillInstallPlan, SkillInstallReceipt, SkillOperationResult, SkillVerifyResult, SkillRetentionResult, SkillMaintenanceResult, SkillMaintenanceApplyParams } from "./skill-install";
import { SkillNativePlanParams, SkillNativeApplyParams, SkillNativeOperationParams, SkillNativeVerifyParams, SkillNativeOperationResult, SkillNativeVerifyResult } from "./skill-native";
import { SkillPlacementPlan, SkillPlacementReceipt } from "./skill-placement";
import { PluginPlanParams, PluginApplyParams, PluginInspectParams, PluginOperationPlan, PluginOperationReceipt, PluginOperationResult } from "./plugin-operation";

/**
 * `_meta` carries W3C trace context (superwitness C2). Optional: a node that predates it
 * ignores the key, and a request made outside any trace has none.
 */
export const TraceMetaSchema = z.object({ traceparent: z.string(), tracestate: z.string().optional() });
export const RequestMsg = z.object({
  type: z.literal("req"),
  id: z.string(),
  verb: z.string(),
  params: z.unknown(),
  _meta: TraceMetaSchema.optional(),
});
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
  "skills.plan": SkillPlanParams,
  "skills.rollback": SkillOperationParams,
  "skills.apply": SkillApplyParams,
  "skills.operation": SkillOperationParams,
  "skills.verify": SkillVerifyParams,
  "skills.retention": SkillRetentionParams,
  "skills.maintenance.plan": SkillRetentionParams,
  "skills.maintenance.apply": SkillMaintenanceApplyParams,
  "skills.native.plan": SkillNativePlanParams,
  "skills.native.apply": SkillNativeApplyParams,
  "skills.native.operation": SkillNativeOperationParams,
  "skills.native.verify": SkillNativeVerifyParams,
  "plugins.plan": PluginPlanParams,
  "plugins.apply": PluginApplyParams,
  "plugins.operation": PluginInspectParams,
  "skills.inventory": SkillInventoryParams,
  "detect": z.object({}),
  "health": z.object({ key: z.string() }),
  "fs.list": z.object({ key: z.string(), path: z.string() }),
  /** `maxBytes` is clamped by the node (4 MiB for an offset read). */
  "fs.read": z.object({ key: z.string(), path: z.string(), maxBytes: z.number().int().optional(), offset: z.number().int().nonnegative().optional() }),
  /** Folder manifest. `maxFiles` <= 500, `maxBytes` <= 100 MiB. */
  "fs.walk": z.object({ key: z.string(), path: z.string(), maxFiles: z.number().int().positive().max(500).optional(), maxBytes: z.number().int().positive().max(100 * 1024 * 1024).optional() }),
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
  // instance is an opaque, caller-chosen discriminator for a distinct ACP process
  // under the same station key. Omitted means "legacy: reuse any existing process
  // for this key".
  // mcpProxy asks the node to add its loopback MCP proxy (the hub's MCP and Superlibrary's, each
  // reached as the station's own agent) to the session's `session/new`. Optional: an old hub never
  // sends it, and an old node ignores it and does not echo it. The node decides — it injects only
  // for a station its operator named and a harness that takes HTTP MCP servers — and says so in
  // the result. The proxy's per-station secret never leaves the node; the hub learns only names.
  "acp.open":   z.object({
    key: z.string(),
    instance: z.string().optional(),
    mcpProxy: z.object({ stationId: z.string().min(1) }).optional(),
  }),
  "acp.attach": z.object({ sessionId: z.string() }),
  "acp.close":  z.object({ sessionId: z.string() }),
  // base affects the COMMITTED side only; uncommitted is always vs HEAD.
  "changeset.status": z.object({ key: z.string(), base: z.string().optional() }),
  "changeset.diff": z.object({
    key: z.string(),
    base: z.string().optional(),
    /** Omitted means the whole side's patch, subject to maxBytes. */
    path: z.string().optional(),
    side: ChangesetDiffSide,
    maxBytes: z.number().int().positive().optional(),
  }),
  // Node-level: no station key. One scan describes one machine.
  "posture.scan": z.object({}),
  /**
   * The public half of the SSH key a station pushes to forge with, generated on the node on first
   * ask. Provisioning is explicit — the hub asks for the stations an operator chose, never for
   * every station — so there is no "ensure all".
   *
   * BOTH names of the station, for the same reason `matrix.adopt` carries both and neither can
   * stand in for the other: `stationId` is the hub's, stable across a rename, and is what
   * revocation is keyed by; `stationKey` is the only name the node knows, and the node records it
   * beside the key so the harness spawn path can find which key belongs to the station it is
   * starting. Both are non-secret, which keeps this on the broker's rule that no credential ever
   * rides in a frame — and here the SECRET NEVER MOVES AT ALL: the private half is generated on the
   * node and stays there, and the hub registers only what comes back.
   */
  "git.identity.ensure": z.object({
    stationId: z.string(),
    stationKey: z.string(),
    /**
     * Who the station's commits are by. The node records it beside the key and puts it in the
     * harness's environment as GIT_AUTHOR_* / GIT_COMMITTER_*, so a commit carries the agent's
     * own name rather than whatever the host's git config says.
     *
     * Optional so a hub that predates it, and a node that predates it, keep working: an older node
     * ignores the field, and an ensure without it leaves an already-recorded author as it was.
     * Both halves or neither — a name with the host's email is attributed to nobody.
     */
    author: z.object({ name: z.string().min(1), email: z.string().min(1) }).optional(),
  }),
  // Withdrawal. By id alone: a rename must not be able to miss the key it meant to delete. The
  // forge side is the hub's own to revoke; this only deletes the node's copy, so that a station
  // reassigned to another agent cannot be handed the previous occupant's key.
  "git.identity.remove": z.object({ stationId: z.string() }),
  // key is the station key (e.g. "hermes:writer-quill") — what the node
  // uses to resolve the profile directory. stationId is the station's
  // database id — what the hub's redemption endpoint
  // (POST /api/nodes/:nodeId/stations/:stationId/matrix-credential) is
  // keyed by. Neither can stand in for the other; both are non-secret, so
  // sending both keeps this on the broker's own constraint that a
  // credential never rides along here.
  "matrix.adopt": z.object({ key: z.string(), stationId: z.string() }),
  // Push a station's resolved voice-note transcription setting into its
  // harness profile. Same shape and the same rule as matrix.adopt: the node
  // needs the key (profile dir), the hub's config endpoint
  // (POST /api/nodes/:nodeId/stations/:stationId/transcription) needs the
  // database id, and the STT API key is fetched over that endpoint with the
  // node's own credential — it never rides in a broker frame.
  "transcription.apply": z.object({ key: z.string(), stationId: z.string() }),
  // Push a station's resolved spoken-reply setting (speech service, voice,
  // when to speak) into its harness profile. Its own verb rather than a
  // widened transcription.apply: a node that predates it answers "unknown
  // verb" instead of silently applying half, and nodes that know only
  // transcription.apply keep working unchanged. Same rule as the two above:
  // the speech service's key is fetched over
  // POST /api/nodes/:nodeId/stations/:stationId/speech with the node's own
  // credential and never rides in a broker frame.
  "speech.apply": z.object({ key: z.string(), stationId: z.string() }),
  // Make a workspace image a harness-mode station's Matrix avatar. The node
  // uploads it with the harness's own access token, which it reads from the
  // profile and never sends: the hub's appservice cannot act for an identity
  // outside its namespace, and nobody but the node needs that token.
  "matrix.avatar.set": z.object({ key: z.string(), path: z.string().min(1) }),
} as const;

// VERB_RESULTS describes what the NODE returns on each verb.
// NOTE: "detect" returns plain Station[] (no adopted field) — the hub
// annotates adopted:true/false from its DB before forwarding to clients.
export const VERB_RESULTS = {
  "skills.plan": SkillInstallPlan,
  "skills.rollback": SkillInstallPlan,
  "skills.apply": SkillInstallReceipt,
  "skills.operation": SkillOperationResult,
  "skills.verify": SkillVerifyResult,
  "skills.retention": SkillRetentionResult,
  "skills.maintenance.plan": SkillMaintenanceResult,
  "skills.maintenance.apply": SkillMaintenanceResult,
  "skills.native.plan": SkillPlacementPlan,
  "skills.native.apply": SkillPlacementReceipt,
  "skills.native.operation": SkillNativeOperationResult,
  "skills.native.verify": SkillNativeVerifyResult,
  "plugins.plan": PluginOperationPlan,
  "plugins.apply": PluginOperationReceipt,
  "plugins.operation": PluginOperationResult,
  "skills.inventory": SkillInventory,
  "detect": z.array(Station),
  "health": StationHealth,
  "fs.list": z.array(FsEntry),
  "fs.read": z.object({
    content: z.string(), encoding: z.enum(["utf8","base64"]), truncated: z.boolean(),
    /** Echoed for an offset read. A node that does not echo it ignored `offset` (Superlibrary plan Task A6). */
    offset: z.number().int().nonnegative().optional(),
    size: z.number().int().nonnegative().optional(),
    eof: z.boolean().optional(),
  }),
  /**
   * `root` echoes the request path as sent. Walking a single file lists it once with `path: ""`.
   * Skip reasons: `denied` (path denylist or harness-private), `symlink` (never followed),
   * `special` (not a regular file), `unreadable` (the node could not read it).
   * `tooMany` is set when the file, skipped-list or visited-entries limit stopped the walk;
   * `truncatedBy` says which one (`bytes` accompanies `tooLarge`). Absent on a complete walk
   * and from older nodes.
   */
  "fs.walk": z.object({
    root: z.string(),
    files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() })),
    skipped: z.array(z.object({ path: z.string(), reason: z.enum(["denied", "symlink", "special", "unreadable"]) })),
    tooMany: z.boolean(), tooLarge: z.boolean(),
    truncatedBy: z.enum(["files", "bytes", "skipped", "entries"]).optional(),
  }),
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
  // instance echoes the request's instance when the node understands it. A
  // result missing instance is how the hub detects an older node and degrades
  // safely (single-process-per-key behavior).
  // mcpProxy names the MCP servers the node injected into this session's `session/new` — absent
  // when it injected nothing (not asked, not configured, a harness without HTTP MCP, an old node).
  // It is the ONLY evidence the session has them, and the card prompt names their tools only then.
  "acp.open":  z.object({
    sessionId: z.string(),
    instance: z.string().optional(),
    mcpProxy: z.array(z.string()).optional(),
  }),
  "acp.close": z.object({ ok: z.boolean() }),
  // acp.attach streams; no entry needed (same as term.attach).
  "changeset.status": ChangesetStatus,
  "changeset.diff": ChangesetDiff,
  "posture.scan": PostureReport,
  /**
   * `publicKey` is an OpenSSH public key line. `created` distinguishes a freshly minted pair from
   * one that already existed, which is what makes a repeated provision safe to run.
   *
   * There is deliberately no path and no private key here. The hub has no use for either, and a
   * key path in a hub log is a map to the one file on that node worth stealing.
   */
  "git.identity.ensure": z.object({ publicKey: z.string(), created: z.boolean() }),
  "git.identity.remove": z.object({ removed: z.boolean() }),
  /**
   * `matrixId` is what closes the move.
   *
   * Design §4 step 5 said "the node reports the new mxid on its next detect",
   * and there is no next detect: `matrix.adopt` restarts the HARNESS, not the
   * node-agent, so the websocket that carries a detect never reopens, and
   * nothing else on this channel carries an mxid. Without it a station works
   * after a move and `stations.matrix_id` stays stale forever — no
   * convergence, no retirement, the old credential still live.
   *
   * So the node reads the identity back out of the profile it just wrote,
   * through the SAME reader a detect would have used
   * (`descriptor.MatrixIDFromProfile`), and returns it here. That is not a
   * weaker signal than the designed one: it is the designed one, taken at the
   * only moment the node is guaranteed to be talking to the hub about this
   * station — and it re-verifies the write through the real reader, which is
   * the assertion the conformance suite already treats as load-bearing.
   *
   * Nullable and optional: null when the reader could not find an identity in
   * the profile (a write that landed somewhere the reader does not look —
   * exactly the failure §3 exists to catch), absent from a node that predates
   * this field, which the hub reads as "nothing reported" and leaves the
   * station unconverged rather than guessing.
   */
  "matrix.adopt": z.object({
    accepted: z.boolean(),
    matrixId: z.string().nullable().optional(),
  }),
  /**
   * What the node wrote into the harness profile, and whether the harness was
   * restarted to pick it up. `restarted: false` with `applied: true` is a
   * station without the `lifecycle` capability (a Hermes profile sharing the
   * root gateway, issue #273): the config is written, and takes effect when
   * that gateway next restarts. No url or key comes back.
   */
  "transcription.apply": z.object({
    applied: z.boolean(),
    mode: z.enum(["on", "off"]),
    model: z.string().nullable(),
    restarted: z.boolean(),
  }),
  /**
   * What the node wrote into the harness profile. `mode: "on"` = the harness's
   * text-to-speech now points at the hub's speech service, speaking in
   * `voice`; "off" = the station has no speech service, so the harness stops
   * speaking unprompted and its TTS provider is left as it was. `speakMode` is
   * what the hub asked for; `autoSpeak` is what the harness will do after the
   * write (Hermes `voice.auto_tts`: true = it speaks every reply). They differ
   * for `voice_in`, which Hermes has no profile setting for — see
   * docs/OPERATING.md §7d. `restarted` as for transcription.apply. No url or
   * key comes back.
   */
  "speech.apply": z.object({
    applied: z.boolean(),
    mode: z.enum(["on", "off"]),
    voice: z.string().nullable(),
    speakMode: z.enum(["off", "voice_in", "always"]).nullable(),
    autoSpeak: z.boolean(),
    restarted: z.boolean(),
  }),
  /** Who now wears the image, and where the homeserver keeps it. */
  "matrix.avatar.set": z.object({
    matrixId: z.string(),
    mxc: z.string().startsWith("mxc://"),
  }),
} as const;
