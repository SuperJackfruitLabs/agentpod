import { z } from "zod";

// ─── What the hub's push gateway sends to a phone ────────────────────────────
//
// The hub is the Matrix push gateway for supermessage (`POST
// /_matrix/push/v1/notify`, operator decision 2026-09-28). The homeserver's
// pusher is `format: "event_id_only"`, so the gateway is told which event and
// how many unread — never what was said — and it forwards exactly that. The
// app's Notification Service Extension fetches and decrypts the event itself.
//
// This schema is `.strict()` all the way down on purpose: it is the list of
// everything a push may carry, and a field that is not on it is a field that
// must not reach Apple. Message content has no place here.

/**
 * What a push is about, when the hub itself posted the event: a permission
 * request an agent is parked on, or a superpipeline approval gate. Metadata
 * only — it says "this is a question", never what the question is.
 */
export const PushCategory = z.enum(["PERMISSION", "GATE"]);
export type PushCategory = z.infer<typeof PushCategory>;

/** The fixed alert text. The extension replaces it after decrypting. */
export const PUSH_ALERT_TITLE = "supermessage";
export const PUSH_ALERT_BODY = "New message";

export const ApnsPushPayload = z
  .object({
    aps: z
      .object({
        alert: z
          .object({ title: z.literal(PUSH_ALERT_TITLE), body: z.literal(PUSH_ALERT_BODY) })
          .strict(),
        "mutable-content": z.literal(1),
        sound: z.literal("default"),
        badge: z.number().int().nonnegative().optional(),
        "thread-id": z.string().optional(),
        category: PushCategory.optional(),
        "interruption-level": z.literal("time-sensitive").optional(),
      })
      .strict(),
    room_id: z.string().optional(),
    event_id: z.string().optional(),
    unread_count: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ApnsPushPayload = z.infer<typeof ApnsPushPayload>;
