import { z } from "zod";

// ─── The fleet Live Activity: what the hub pushes to a Lock Screen ───────────
//
// Spec: supermessage `docs/superpowers/specs/2026-09-29-fleet-live-activity-and-recap-widgets-design.md`
// (A3, A4). One Live Activity for the reader's whole fleet, driven by the hub
// over APNs `liveactivity` pushes so it stays live with the app closed.
//
// **This text reaches Apple in plaintext.** Agent names, the current step's
// title and a pending decision's question and options ride in the push, by
// operator decision (2026-09-29). It is the one deliberate exception to the
// gateway's rule that nothing a person wrote passes through Apple — the
// message push (`push.ts`) still carries ids only.
//
// `ContentState` is shared with Swift (`FleetActivityAttributes.ContentState`)
// and pinned by `fixtures/fleet-content-state.json` and `-v2.json` (turn phase,
// avatar key and finish time), which are copied into both
// repositories. JSON keys are camelCase. The hub applies every bound here; the
// app decodes leniently (unknown keys ignored, a missing optional key is none).
// Strict on this side so a key the app has never heard of cannot leave.

export const FLEET_AGENTS_MAX = 3;
export const FLEET_STEP_MAX = 60;
export const FLEET_QUESTION_MAX = 120;
export const FLEET_DECISION_OPTIONS_MAX = 2;
/** Apple's ceiling for a Live Activity push payload. */
export const LIVE_ACTIVITY_PAYLOAD_MAX_BYTES = 4096;
/** The ActivityKit attributes type the app registers. */
export const FLEET_ATTRIBUTES_TYPE = "FleetActivityAttributes";

/** A bound in characters (code points), which is what a person sees. */
const chars = (max: number) => z.string().refine((s) => [...s].length <= max, `at most ${max} characters`);

const unixSeconds = z.number().int().nonnegative();
const count = z.number().int().nonnegative();

export const FleetLiveAgentState = z.enum(["working", "needs_you", "active", "done", "failed"]);
export type FleetLiveAgentState = z.infer<typeof FleetLiveAgentState>;

/**
 * Where a working turn is on the card's track (Thinking → Tools → Writing →
 * Done). Spec 2026-09-30 A1. Optional: without it the app draws the track
 * from the counts alone.
 */
export const FleetLivePhase = z.enum(["thinking", "tools", "writing"]);
export type FleetLivePhase = z.infer<typeof FleetLivePhase>;

// Keys in the order `fixtures/fleet-content-state-v2.json` writes them; zod
// emits them in this order. `mxid`, `phase` and `endedAt` are the 2026-09-30
// additions, all optional, so an app built before them still decodes.
export const FleetLiveAgent = z
  .object({
    roomId: z.string().min(1),
    /** The agent's Matrix id; the app keys its cached avatar by it. */
    mxid: z.string().min(1).optional(),
    name: z.string().min(1),
    state: FleetLiveAgentState,
    /** Only while `state` is `working`. */
    phase: FleetLivePhase.optional(),
    step: chars(FLEET_STEP_MAX).optional(),
    completed: count.optional(),
    total: count.optional(),
    /** Unix seconds: when the turn started (also for a finished row), or the last activity. */
    since: unixSeconds,
    /** Unix seconds: when the turn finished. Only while `state` is `done` or `failed`. */
    endedAt: unixSeconds.optional(),
  })
  .strict();
export type FleetLiveAgent = z.infer<typeof FleetLiveAgent>;

export const FleetLiveDecisionOption = z
  .object({
    /** What the app sends back to answer: the option's name for a permission, the gate option id for a gate. */
    id: z.string().min(1),
    label: z.string().min(1),
    declines: z.boolean(),
  })
  .strict();
export type FleetLiveDecisionOption = z.infer<typeof FleetLiveDecisionOption>;

export const FleetLiveDecision = z
  .object({
    roomId: z.string().min(1),
    eventId: z.string().min(1),
    agent: z.string().min(1),
    kind: z.enum(["permission", "gate"]),
    question: chars(FLEET_QUESTION_MAX),
    /** Inline options only — at most two. */
    options: z.array(FleetLiveDecisionOption).max(FLEET_DECISION_OPTIONS_MAX),
  })
  .strict();
export type FleetLiveDecision = z.infer<typeof FleetLiveDecision>;

export const FleetContentState = z
  .object({
    /** needs_you first, then working, then most recent. */
    agents: z.array(FleetLiveAgent).max(FLEET_AGENTS_MAX),
    /** Active agents not listed. */
    more: count,
    /** The oldest pending decision. */
    decision: FleetLiveDecision.optional(),
    /** Pending decisions in all. */
    needsYou: count,
    working: count,
    updatedAt: unixSeconds,
  })
  .strict();
export type FleetContentState = z.infer<typeof FleetContentState>;

const LiveActivityAlert = z.object({ title: z.string(), body: z.string() }).strict();

/**
 * The `aps` of a push-to-start, an update or an end. One schema for the three
 * rather than a union, so a field in the wrong event is caught by the builder's
 * tests rather than by a parse error here — `event` says which it is.
 */
export const LiveActivityPushPayload = z
  .object({
    aps: z
      .object({
        timestamp: unixSeconds,
        event: z.enum(["start", "update", "end"]),
        "content-state": FleetContentState,
        "attributes-type": z.literal(FLEET_ATTRIBUTES_TYPE).optional(),
        attributes: z.object({ readerId: z.string().min(1) }).strict().optional(),
        alert: LiveActivityAlert.optional(),
        "stale-date": unixSeconds.optional(),
        "dismissal-date": unixSeconds.optional(),
      })
      .strict(),
  })
  .strict();
export type LiveActivityPushPayload = z.infer<typeof LiveActivityPushPayload>;

// ─── Token registration (A1) ─────────────────────────────────────────────────

/** An APNs token as the app sends it: hex. Push-to-start tokens run longer than device tokens. */
const APNS_HEX_TOKEN = /^[0-9a-fA-F]{32,512}$/;

export const LiveActivityTokenRegistration = z
  .object({
    kind: z.enum(["start", "update"]),
    token: z.string().regex(APNS_HEX_TOKEN),
    environment: z.enum(["production", "sandbox"]),
    device_id: z.string().min(1).max(255),
    activity_id: z.string().min(1).max(255).optional(),
  })
  .refine((b) => b.kind !== "update" || b.activity_id !== undefined, {
    message: "activity_id is required for an update token",
    path: ["activity_id"],
  });
export type LiveActivityTokenRegistration = z.infer<typeof LiveActivityTokenRegistration>;

export const LiveActivityTokenRemoval = z.object({
  kind: z.enum(["start", "update"]),
  device_id: z.string().min(1).max(255),
  activity_id: z.string().min(1).max(255).optional(),
});
export type LiveActivityTokenRemoval = z.infer<typeof LiveActivityTokenRemoval>;
