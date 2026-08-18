# Agent activity in the room — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an agent's thinking, tool use and permission requests visible in a Matrix room without making the room noisier.

**Architecture:** Extends the split `matrix-as/live.ts` already argues for — live activity goes to-device and is never stored, the durable record is one event per turn. Four independently shippable pieces, in dependency order: a diagnostic for what the hub drops, live thought/tool streaming, a per-turn durable record, and structured approvals.

**Tech Stack:** Bun + TypeScript (hub), zod (contract), Rust + ruma/matrix-sdk (supermessage core), Svelte 5 runes (supermessage UI).

**Spec:** `docs/superpowers/specs/2026-08-17-agent-activity-in-the-room-design.md`

## Global Constraints

- **Contract first.** `packages/contract` is the shared vocabulary; a frame or API shape changes there before anywhere else.
- **TDD, always.** Failing test first, including a regression test for every bug fix.
- **Hub tests need an explicit DATABASE_URL and a pgvector Postgres on :5434.** The tasks here are unit tests that do not touch the DB, but `bun test` runs the whole file set in one process: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test`.
- **`bun run typecheck` is KNOWN RED** in the hub (`typecheck-known-red.txt`). Do not "fix" unrelated errors in passing. Do not add new ones — `tests/unit/typecheck-baseline.test.ts` holds the line.
- **Rust: `cargo fmt` runs LAST**, after any clippy-driven edit. Running it earlier and then editing is how PR #15 went red on main.
- **Never `{@html}` a payload.** `customPayload` is arbitrary JSON from anyone who can send to the room. Renderers read named fields one level at a time with `safeStringField` and return text only.
- **Event type strings are frozen once shipped.** Major version is baked into the type (`dev.agentpod.turn.v1`); additive fields bump `content.schema_version`, which is **snake_case** because that is what `readSchemaVersion` reads.
- **Branch:** `feat/agent-activity-in-the-room` off `main`. Trunk-based, PR per piece is acceptable and preferred over one large PR.

---

## File Structure

**Created**
- `packages/contract/src/matrix-events.ts` — zod schemas + inferred types for all four payloads and the shared `ToolStatus` vocabulary.
- `packages/contract/src/matrix-events.test.ts` — round-trip and rejection tests.
- `apps/hub/src/services/matrix-as/activity.ts` — the pure part: tool-record accumulation, the turn-event builder, the unmapped-kind set. No I/O, so it is testable without a homeserver.
- `apps/hub/src/services/matrix-as/activity.test.ts`

**Modified**
- `packages/contract/src/index.ts` — re-export the new module.
- `apps/hub/src/services/matrix-as/live.ts` — two new to-device type constants and their content builders.
- `apps/hub/src/services/matrix-as/live.test.ts` — cover them.
- `apps/hub/src/services/matrix-as/client.ts` — one new method, `sendCustomEvent`.
- `apps/hub/src/services/matrix-as/outbound.ts` — the switch, the per-turn state, the emit points.
- `apps/hub/src/services/matrix-as/outbound.test.ts` — the behaviour tests.
- `supermessage/src-tauri/src/core/live.rs` — two more to-device handlers.
- `supermessage/src/lib/ipc.ts` — two more channel subscriptions.
- `supermessage/src/lib/stores/live.svelte.ts` — thought text alongside answer text.
- `supermessage/src/lib/components/customEvents.ts` — two renderers + one entry in `DECISION_BEARING_EVENT_TYPES`.
- `supermessage/src/lib/components/Timeline.svelte` — `onDecide` sends instead of warning.

**Deliberately untouched**
- `apps/hub/src/services/matrix-as/permissions.ts` — `matchPermissionAnswer` already accepts the option's name. Using it is the whole reason approvals cost no new plumbing.
- `supermessage/src-tauri/src/core/timeline.rs` — `timeline_event_filter` already whitelists `AnyMessageLikeEventContent::_Custom(_)` generically, so a new event type needs no Rust change to reach the timeline.

---

## Task 1: The diagnostic — record what the hub drops

Ship first. It makes every later task observable, and it is the reason the next capability a harness gains will not vanish the way tool calls did.

**Files:**
- Create: `apps/hub/src/services/matrix-as/activity.ts`
- Create: `apps/hub/src/services/matrix-as/activity.test.ts`
- Modify: `apps/hub/src/services/matrix-as/outbound.ts`

**Interfaces:**
- Produces: `noteUnmappedKind(kind: string): boolean`, `unmappedKinds(): string[]`, `_resetUnmappedForTest(): void`

- [ ] **Step 1: Write the failing test**

Create `apps/hub/src/services/matrix-as/activity.test.ts`:

```ts
// What the Matrix path does with an ACP update kind it does not handle.
//
// It used to do nothing at all — no default case, no log — which is how
// `tool_call` was discarded for the entire life of the bridge without a single
// line anywhere saying so. The kaambaan coalescer keeps `unmapped()`/`losses()`
// for exactly this reason (`bridge/coalesce.ts:104-111`); this is the same idea
// on the path that lacked it.

import { beforeEach, describe, expect, it } from "bun:test";
import { _resetUnmappedForTest, noteUnmappedKind, unmappedKinds } from "./activity";

describe("unmapped session update kinds", () => {
  beforeEach(() => {
    _resetUnmappedForTest();
  });

  it("has nothing to report before anything unknown arrives", () => {
    expect(unmappedKinds()).toEqual([]);
  });

  it("reports a kind it has never seen, so the caller can log it once", () => {
    expect(noteUnmappedKind("plan")).toBe(true);
    expect(unmappedKinds()).toEqual(["plan"]);
  });

  it("does not report the same kind twice, so a busy session logs once", () => {
    expect(noteUnmappedKind("plan")).toBe(true);
    expect(noteUnmappedKind("plan")).toBe(false);
    expect(noteUnmappedKind("plan")).toBe(false);
    expect(unmappedKinds()).toEqual(["plan"]);
  });

  it("keeps kinds sorted, so two runs of the same fleet read the same", () => {
    noteUnmappedKind("usage_update");
    noteUnmappedKind("current_mode_update");
    noteUnmappedKind("plan");
    expect(unmappedKinds()).toEqual(["current_mode_update", "plan", "usage_update"]);
  });

  it("ignores a kind that is not a string, rather than recording garbage", () => {
    // `payload.sessionUpdate` is `unknown` — it comes off a `z.unknown()`
    // payload and nothing validates it upstream.
    expect(noteUnmappedKind(undefined as unknown as string)).toBe(false);
    expect(noteUnmappedKind(42 as unknown as string)).toBe(false);
    expect(unmappedKinds()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/matrix-as/activity.test.ts
```

Expected: FAIL — `Cannot find module './activity'`.

- [ ] **Step 3: Write the implementation**

Create `apps/hub/src/services/matrix-as/activity.ts`:

```ts
/**
 * What the Matrix path does with the parts of an ACP turn it does not forward.
 *
 * `outbound.ts` used to answer "is this an `agent_message_chunk`?" and return
 * `undefined` for everything else — no default case, no logging, no record.
 * That is how `tool_call` came to be discarded for the whole life of the bridge
 * with nothing anywhere saying so. The kaambaan coalescer already keeps
 * `unmapped()`/`losses()` and lists its dropped kinds explicitly "so a NEW kind
 * shows up in `unmapped()` instead of joining this set by accident"
 * (`bridge/coalesce.ts:53-62`). This is that discipline, on the path that
 * lacked it.
 */

/**
 * Kinds seen and not handled, for the life of the process.
 *
 * Module-level rather than per-attachment: the question is "does this fleet's
 * harness emit something we ignore", which is not a property of one room. A
 * `Set` also makes the log once-per-kind rather than once-per-event — a busy
 * session emits hundreds of the same update, and a line per event would bury
 * the signal it exists to raise.
 */
const unmapped = new Set<string>();

/**
 * Records `kind` as unhandled. Returns whether it was **new** — the caller logs
 * only when it was, so a kind that arrives four hundred times says so once.
 */
export function noteUnmappedKind(kind: string): boolean {
  if (typeof kind !== "string" || kind === "") return false;
  if (unmapped.has(kind)) return false;
  unmapped.add(kind);
  return true;
}

/** Every unhandled kind seen so far, sorted so two runs read the same. */
export function unmappedKinds(): string[] {
  return [...unmapped].sort();
}

/** Test seam: the set outlives any one test by design. */
export function _resetUnmappedForTest(): void {
  unmapped.clear();
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/matrix-as/activity.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the `agent-update` case**

In `apps/hub/src/services/matrix-as/outbound.ts`, add to the imports:

```ts
import { noteUnmappedKind } from "./activity";
```

Replace the `agent-update` case body (currently lines 356-364) with:

```ts
        case "agent-update": {
          const text = messageChunkText(event.payload);
          if (text !== undefined) {
            state.buffer.push(text);
            void streamLive(false);
            scheduleFlush();
            return;
          }
          // Anything this path does not forward is recorded once, so the next
          // capability a harness gains does not vanish here the way tool calls
          // did. See `activity.ts`.
          const kind = isRecord(event.payload) ? event.payload.sessionUpdate : undefined;
          if (typeof kind === "string" && noteUnmappedKind(kind)) {
            log.info("a session update kind reaches Matrix and is not forwarded", {
              sessionId,
              kind,
            });
          }
          return;
        }
```

- [ ] **Step 6: Run the hub suite**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
```

Expected: PASS, no new failures.

- [ ] **Step 7: Commit**

```bash
git add apps/hub/src/services/matrix-as/activity.ts apps/hub/src/services/matrix-as/activity.test.ts apps/hub/src/services/matrix-as/outbound.ts
git commit -m "fix: say so when the Matrix path drops a session update kind"
```

---

## Task 2: Contract — the shared vocabulary

**Files:**
- Create: `packages/contract/src/matrix-events.ts`
- Create: `packages/contract/src/matrix-events.test.ts`
- Modify: `packages/contract/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ToolStatus`, `LiveThoughtDelta`, `LiveToolUpdate`, `TurnActivity`, `TurnActivityTool`, `PermissionRequestEvent` — each a zod schema with an inferred type of the same name.

- [ ] **Step 1: Write the failing test**

Create `packages/contract/src/matrix-events.test.ts`:

```ts
// The wire shapes the hub sends and supermessage reads.
//
// Snake_case throughout, like every other Matrix event — see `live.ts`'s
// `deltaContent`. `schema_version` in particular is snake_case because that is
// the field supermessage's `readSchemaVersion` looks for; camelCasing it means
// every payload silently reads as "assume the baseline version".

import { describe, expect, it } from "bun:test";
import {
  LiveThoughtDelta,
  LiveToolUpdate,
  PermissionRequestEvent,
  ToolStatus,
  TurnActivity,
} from "./matrix-events";

describe("ToolStatus", () => {
  it("is exactly ACP's vocabulary, so the console and the room cannot drift", () => {
    expect(ToolStatus.options).toEqual(["pending", "in_progress", "completed", "failed"]);
  });

  it("rejects a status nobody defined", () => {
    expect(ToolStatus.safeParse("cancelled").success).toBe(false);
  });
});

describe("LiveThoughtDelta", () => {
  it("accepts a delta", () => {
    const parsed = LiveThoughtDelta.parse({
      room_id: "!r:example.org",
      session_id: "sess_1",
      seq: 3,
      text: "Considering the node's uptime.",
      done: false,
    });
    expect(parsed.seq).toBe(3);
  });

  it("requires done, because a receiver keys the end of a turn off it", () => {
    expect(
      LiveThoughtDelta.safeParse({
        room_id: "!r:example.org",
        session_id: "sess_1",
        seq: 3,
        text: "x",
      }).success,
    ).toBe(false);
  });
});

describe("LiveToolUpdate", () => {
  it("accepts an update", () => {
    const parsed = LiveToolUpdate.parse({
      room_id: "!r:example.org",
      session_id: "sess_1",
      seq: 4,
      tool_call_id: "call_1",
      title: "Read src/main.ts",
      kind: "read",
      status: "in_progress",
      locations: ["src/main.ts"],
    });
    expect(parsed.tool_call_id).toBe("call_1");
  });

  it("tolerates a missing kind, which ACP does not always send", () => {
    const parsed = LiveToolUpdate.parse({
      room_id: "!r:example.org",
      session_id: "sess_1",
      seq: 4,
      tool_call_id: "call_1",
      title: "Something",
      status: "pending",
      locations: [],
    });
    expect(parsed.kind).toBeUndefined();
  });

  it("requires the tool call id, since it is the identity updates merge onto", () => {
    expect(
      LiveToolUpdate.safeParse({
        room_id: "!r:example.org",
        session_id: "sess_1",
        seq: 4,
        title: "Something",
        status: "pending",
        locations: [],
      }).success,
    ).toBe(false);
  });
});

describe("TurnActivity", () => {
  it("accepts a turn's record", () => {
    const parsed = TurnActivity.parse({
      schema_version: 1,
      session_id: "sess_1",
      tools: [
        {
          id: "call_1",
          title: "Read src/main.ts",
          kind: "read",
          status: "completed",
          locations: ["src/main.ts"],
        },
      ],
      counts: { total: 1, failed: 0, omitted: 0 },
    });
    expect(parsed.counts.total).toBe(1);
  });

  it("carries schema_version in snake_case, which is what the client reads", () => {
    expect(
      TurnActivity.safeParse({
        schemaVersion: 1,
        session_id: "sess_1",
        tools: [],
        counts: { total: 0, failed: 0, omitted: 0 },
      }).success,
    ).toBe(false);
  });
});

describe("PermissionRequestEvent", () => {
  it("accepts a request", () => {
    const parsed = PermissionRequestEvent.parse({
      schema_version: 1,
      session_id: "sess_1",
      request_seq: 41,
      title: "Write src/main.ts",
      options: [
        { option_id: "allow_once", name: "Allow once" },
        { option_id: "reject", name: "Reject" },
      ],
    });
    expect(parsed.options).toHaveLength(2);
  });

  it("refuses more than four options, the cap the card can actually render", () => {
    // `DECISION_MAX_OPTIONS` in supermessage's `customEvents.ts` silently drops
    // the fifth. Refusing here means the hub never sends one it knows will be
    // discarded — the cap is enforced where it can still be reported.
    expect(
      PermissionRequestEvent.safeParse({
        schema_version: 1,
        session_id: "sess_1",
        request_seq: 41,
        title: "x",
        options: [
          { option_id: "a", name: "A" },
          { option_id: "b", name: "B" },
          { option_id: "c", name: "C" },
          { option_id: "d", name: "D" },
          { option_id: "e", name: "E" },
        ],
      }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd packages/contract && bun test src/matrix-events.test.ts
```

Expected: FAIL — `Cannot find module './matrix-events'`.

- [ ] **Step 3: Write the implementation**

Create `packages/contract/src/matrix-events.ts`:

```ts
import { z } from "zod";

// ─── Matrix event payloads the hub sends ─────────────────────────────────────
//
// Snake_case throughout, like every other Matrix event body and like
// `matrix-as/live.ts`'s existing `deltaContent`. `schema_version` in particular
// is snake_case because that is the field supermessage's `readSchemaVersion`
// looks for; camelCasing it makes every payload read as "assume the baseline
// version" with no error anywhere.

/** ACP's tool lifecycle, verbatim. Matches the console's `TOOL_STATUSES`. */
export const ToolStatus = z.enum(["pending", "in_progress", "completed", "failed"]);
export type ToolStatus = z.infer<typeof ToolStatus>;

/**
 * A turn's reasoning, streamed to the reader's own devices.
 *
 * Deliberately the same shape as the existing `dev.agentpod.stream.delta`: the
 * client's seq-ordering and its reveal pacer already handle "cumulative text
 * with a monotonic seq, at-least-once and unordered", so reusing the shape
 * costs one registration rather than a second implementation. `text` is
 * EVERYTHING so far, never the increment — see `live.ts`.
 */
export const LiveThoughtDelta = z.object({
  room_id: z.string(),
  session_id: z.string(),
  seq: z.number().int().nonnegative(),
  text: z.string(),
  done: z.boolean(),
});
export type LiveThoughtDelta = z.infer<typeof LiveThoughtDelta>;

/**
 * One tool call's state, streamed as it changes.
 *
 * `tool_call` and `tool_call_update` both produce this; the receiver upserts by
 * `tool_call_id`. Tool *output* is deliberately absent — it is unbounded, and
 * this is a live ticker rather than a viewer.
 */
export const LiveToolUpdate = z.object({
  room_id: z.string(),
  session_id: z.string(),
  seq: z.number().int().nonnegative(),
  tool_call_id: z.string(),
  title: z.string(),
  /** ACP's tool kind, passed through unvalidated. Treat as opaque display text. */
  kind: z.string().optional(),
  status: ToolStatus,
  locations: z.array(z.string()),
});
export type LiveToolUpdate = z.infer<typeof LiveToolUpdate>;

/** One tool call as it appears in the durable per-turn record. */
export const TurnActivityTool = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string().optional(),
  status: ToolStatus,
  locations: z.array(z.string()),
});
export type TurnActivityTool = z.infer<typeof TurnActivityTool>;

/**
 * What an agent did during one turn — the durable record, sent into the room
 * once, before the answer.
 *
 * `tools` is capped by the sender; `counts` still reports the truth about the
 * whole turn, so a capped list never reads as a complete one.
 */
export const TurnActivity = z.object({
  schema_version: z.literal(1),
  session_id: z.string(),
  tools: z.array(TurnActivityTool),
  counts: z.object({
    total: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
  }),
});
export type TurnActivity = z.infer<typeof TurnActivity>;

/**
 * A permission request, structured so a client can render buttons.
 *
 * Sent **beside** the existing prose message, which is unchanged and remains
 * the interop path for any other Matrix client. The answer travels back as an
 * ordinary message carrying the option's `name`, which
 * `matrix-as/permissions.ts`'s `matchPermissionAnswer` already accepts.
 *
 * Four options maximum, because supermessage's `DECISION_MAX_OPTIONS` renders
 * four and silently drops the rest. Enforcing it here means the hub never sends
 * something it knows will be discarded.
 */
export const PermissionRequestEvent = z.object({
  schema_version: z.literal(1),
  session_id: z.string(),
  /** The request's own ACP sequence number — how `answerPermission` addresses it. */
  request_seq: z.number().int().nonnegative(),
  title: z.string(),
  options: z
    .array(z.object({ option_id: z.string(), name: z.string() }))
    .min(1)
    .max(4),
});
export type PermissionRequestEvent = z.infer<typeof PermissionRequestEvent>;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/contract && bun test
```

Expected: PASS.

- [ ] **Step 5: Re-export from the package index**

Append to `packages/contract/src/index.ts`, following the existing export style in that file:

```ts
export * from "./matrix-events";
```

- [ ] **Step 6: Commit**

```bash
git add packages/contract/src/matrix-events.ts packages/contract/src/matrix-events.test.ts packages/contract/src/index.ts
git commit -m "feat(contract): the wire shapes for an agent's activity in a room"
```

---

## Task 3: Live thought and tool streaming (hub side)

**Files:**
- Modify: `apps/hub/src/services/matrix-as/live.ts`
- Modify: `apps/hub/src/services/matrix-as/live.test.ts`
- Modify: `apps/hub/src/services/matrix-as/outbound.ts`
- Modify: `apps/hub/src/services/matrix-as/outbound.test.ts`

**Interfaces:**
- Consumes: `ToolStatus` (Task 2); `shouldSendDelta`, `LIVE_DELTA_TYPE`, `deltaContent` (existing in `live.ts`).
- Produces: `THOUGHT_DELTA_TYPE`, `TOOL_UPDATE_TYPE`, `toolUpdateContent(...)`.

- [ ] **Step 1: Write the failing test for the content builders**

Append to `apps/hub/src/services/matrix-as/live.test.ts`:

```ts
describe("activity to-device types", () => {
  it("names the thought channel distinctly from the answer channel", () => {
    // Same shape, different type: a reader must be able to tell an agent's
    // reasoning from its answer, and the shape is reused precisely so the
    // client needs no second implementation to do it.
    expect(THOUGHT_DELTA_TYPE).toBe("dev.agentpod.thought.delta");
    expect(THOUGHT_DELTA_TYPE).not.toBe(LIVE_DELTA_TYPE);
  });

  it("builds a tool update body in snake_case, like every other Matrix event", () => {
    expect(
      toolUpdateContent({
        roomId: "!r:example.org",
        sessionId: "sess_1",
        seq: 2,
        toolCallId: "call_1",
        title: "Read src/main.ts",
        kind: "read",
        status: "in_progress",
        locations: ["src/main.ts"],
      }),
    ).toEqual({
      room_id: "!r:example.org",
      session_id: "sess_1",
      seq: 2,
      tool_call_id: "call_1",
      title: "Read src/main.ts",
      kind: "read",
      status: "in_progress",
      locations: ["src/main.ts"],
    });
  });

  it("omits a kind ACP did not give, rather than sending an empty string", () => {
    const body = toolUpdateContent({
      roomId: "!r:example.org",
      sessionId: "sess_1",
      seq: 2,
      toolCallId: "call_1",
      title: "Something",
      kind: undefined,
      status: "pending",
      locations: [],
    });
    expect("kind" in body).toBe(false);
  });
});
```

Add `THOUGHT_DELTA_TYPE`, `TOOL_UPDATE_TYPE` and `toolUpdateContent` to that file's existing import from `./live`.

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/matrix-as/live.test.ts
```

Expected: FAIL — the imports do not exist.

- [ ] **Step 3: Add them to `live.ts`**

Append to `apps/hub/src/services/matrix-as/live.ts`:

```ts
/**
 * The to-device event type carrying a turn's reasoning.
 *
 * A separate type from `LIVE_DELTA_TYPE` carrying an identical body: the
 * *shape* is reused so the client's seq-ordering and reveal pacing work
 * unchanged, but the *type* must differ or a reader cannot tell an agent's
 * thinking from its answer. Reasoning is never written to the room — see
 * `outbound.ts`, where that decision has been recorded since before this
 * channel existed.
 */
export const THOUGHT_DELTA_TYPE = "dev.agentpod.thought.delta";

/** The to-device event type carrying one tool call's state. */
export const TOOL_UPDATE_TYPE = "dev.agentpod.tool.update";

/** One tool call's state, as it goes on the wire. */
export interface ToolUpdate {
  roomId: string;
  sessionId: string;
  /** Monotonic per turn, sharing the turn's activity sequence. */
  seq: number;
  /** The identity later updates merge onto. */
  toolCallId: string;
  title: string;
  /** ACP's tool kind. Absent when the harness did not say. */
  kind: string | undefined;
  status: "pending" | "in_progress" | "completed" | "failed";
  locations: string[];
}

/** The wire body for a tool update. Snake case, like every other Matrix event. */
export function toolUpdateContent(update: ToolUpdate): Record<string, unknown> {
  const body: Record<string, unknown> = {
    room_id: update.roomId,
    session_id: update.sessionId,
    seq: update.seq,
    tool_call_id: update.toolCallId,
    title: update.title,
    status: update.status,
    locations: update.locations,
  };
  // Omitted rather than sent empty: absent means "the harness did not say",
  // and `""` would render as a kind called nothing.
  if (update.kind !== undefined) body.kind = update.kind;
  return body;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/matrix-as/live.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing behaviour test**

Append to `apps/hub/src/services/matrix-as/outbound.test.ts`, following that file's existing fake-client and `attachRoomToSession` setup:

```ts
describe("an agent's thinking", () => {
  it("reaches the reader's devices and never the room", async () => {
    // The decision this test defends is older than this test: reasoning
    // "belongs in the console's transcript, not in a room people share, where
    // it would turn one answer into a monologue". 202 thought chunks in one
    // observed Hermes turn is the number behind that sentence.
    const { client, emit, toDevice, sent } = attachFixture();

    emit({
      type: "agent-update",
      seq: 1,
      payload: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Weighing the options carefully. " },
      },
    });
    await flushMicrotasks();

    expect(toDevice.filter((d) => d.eventType === THOUGHT_DELTA_TYPE)).toHaveLength(1);
    expect(sent).toHaveLength(0);
    void client;
  });

  it("keeps its own sequence, so it cannot be mistaken for the answer", async () => {
    const { emit, toDevice } = attachFixture();

    emit({
      type: "agent-update",
      seq: 1,
      payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer. " } },
    });
    emit({
      type: "agent-update",
      seq: 2,
      payload: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thought. " } },
    });
    await flushMicrotasks();

    const answer = toDevice.find((d) => d.eventType === LIVE_DELTA_TYPE);
    const thought = toDevice.find((d) => d.eventType === THOUGHT_DELTA_TYPE);
    expect(answer?.content.seq).toBe(1);
    expect(thought?.content.seq).toBe(1);
    expect(answer?.content.text).toBe("Answer. ");
    expect(thought?.content.text).toBe("Thought. ");
  });
});

describe("tool calls", () => {
  it("streams a tool call to the reader's devices", async () => {
    const { emit, toDevice, sent } = attachFixture();

    emit({
      type: "agent-update",
      seq: 1,
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Read src/main.ts",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "src/main.ts" }],
      },
    });
    await flushMicrotasks();

    const update = toDevice.find((d) => d.eventType === TOOL_UPDATE_TYPE);
    expect(update?.content).toMatchObject({
      tool_call_id: "call_1",
      title: "Read src/main.ts",
      status: "in_progress",
      locations: ["src/main.ts"],
    });
    expect(sent).toHaveLength(0);
  });

  it("merges an update onto its call rather than starting a second one", async () => {
    const { emit, toDevice } = attachFixture();

    emit({
      type: "agent-update",
      seq: 1,
      payload: { sessionUpdate: "tool_call", toolCallId: "call_1", title: "Run tests", status: "pending" },
    });
    emit({
      type: "agent-update",
      seq: 2,
      payload: { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "failed" },
    });
    await flushMicrotasks();

    const updates = toDevice.filter((d) => d.eventType === TOOL_UPDATE_TYPE);
    expect(updates).toHaveLength(2);
    // The title survives an update that did not carry one.
    expect(updates[1]?.content).toMatchObject({
      tool_call_id: "call_1",
      title: "Run tests",
      status: "failed",
    });
  });

  it("ignores a tool call with no id, which nothing could merge onto", async () => {
    const { emit, toDevice } = attachFixture();

    emit({
      type: "agent-update",
      seq: 1,
      payload: { sessionUpdate: "tool_call", title: "Nameless", status: "pending" },
    });
    await flushMicrotasks();

    expect(toDevice.filter((d) => d.eventType === TOOL_UPDATE_TYPE)).toHaveLength(0);
  });
});
```

If `attachFixture` and `flushMicrotasks` do not already exist in that file, add them next to the existing setup, capturing `sendToDevice` calls into a `toDevice` array of `{ eventType, content }` and `sendText` calls into `sent`.

- [ ] **Step 6: Run it to make sure it fails**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/matrix-as/outbound.test.ts
```

Expected: FAIL — no thought or tool events are sent.

- [ ] **Step 7: Implement in `outbound.ts`**

Add to the imports:

```ts
import {
  deltaContent,
  LIVE_DELTA_TYPE,
  shouldSendDelta,
  THOUGHT_DELTA_TYPE,
  TOOL_UPDATE_TYPE,
  toolUpdateContent,
} from "./live";
import { noteUnmappedKind, type ToolRecord } from "./activity";
```

Add to `interface Attachment`:

```ts
  /** The reasoning stream's own buffer and cursor — see `THOUGHT_DELTA_TYPE`. */
  thoughtBuffer: string[];
  thoughtSeq: number;
  thoughtSentChars: number;
  thoughtSentAt: number;
  /**
   * This turn's tool calls, in the order they first appeared, keyed by
   * `toolCallId` so an update merges rather than appending. Cleared with the
   * rest of the per-turn state in `flush`.
   */
  tools: Map<string, ToolRecord>;
  /** Monotonic per turn, shared by every tool update. */
  toolSeq: number;
```

Initialise them in the `state` literal:

```ts
    thoughtBuffer: [],
    thoughtSeq: 0,
    thoughtSentChars: 0,
    thoughtSentAt: 0,
    tools: new Map(),
    toolSeq: 0,
```

Add a chunk reader beside `messageChunkText`:

```ts
/** The text of a chunk of the given kind, or undefined for anything else. */
function chunkTextOfKind(payload: unknown, kind: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (payload.sessionUpdate !== kind) return undefined;
  const content = payload.content;
  if (!isRecord(content) || content.type !== "text") return undefined;
  return typeof content.text === "string" ? content.text : undefined;
}
```

Add the streaming function beside `streamLive`:

```ts
  /**
   * Push the agent's reasoning so far to the reader's devices.
   *
   * The same policy and the same best-effort posture as `streamLive`, against
   * its own buffer and cursor. Reasoning never touches the room, so unlike the
   * answer there is no durable copy behind this — a dropped delta is simply
   * reasoning the reader did not see, which costs nothing.
   */
  const streamThought = async (done: boolean) => {
    const send = deps.client.sendToDevice;
    if (!send) return;
    if (state.reader === undefined) {
      state.reader = deps.readerFor ? await deps.readerFor(roomId).catch(() => null) : null;
    }
    if (!state.reader) return;

    const text = state.thoughtBuffer.join("");
    const pending = text.slice(state.thoughtSentChars);
    if (!done && !shouldSendDelta(pending, Date.now() - state.thoughtSentAt)) return;
    if (done && pending.length === 0 && state.thoughtSeq === 0) return;

    state.thoughtSeq += 1;
    state.thoughtSentChars = text.length;
    state.thoughtSentAt = Date.now();

    await send(
      agentUser,
      state.reader,
      THOUGHT_DELTA_TYPE,
      deltaContent({ roomId, sessionId, seq: state.thoughtSeq, text, done })
    ).catch(() => {});
  };

  /** Push one tool call's current state to the reader's devices. */
  const streamTool = async (record: ToolRecord) => {
    const send = deps.client.sendToDevice;
    if (!send) return;
    if (state.reader === undefined) {
      state.reader = deps.readerFor ? await deps.readerFor(roomId).catch(() => null) : null;
    }
    if (!state.reader) return;

    state.toolSeq += 1;
    await send(
      agentUser,
      state.reader,
      TOOL_UPDATE_TYPE,
      toolUpdateContent({
        roomId,
        sessionId,
        seq: state.toolSeq,
        toolCallId: record.id,
        title: record.title,
        kind: record.kind,
        status: record.status,
        locations: record.locations,
      })
    ).catch(() => {});
  };
```

Extend the `agent-update` case (built on Task 1's version):

```ts
        case "agent-update": {
          const text = messageChunkText(event.payload);
          if (text !== undefined) {
            state.buffer.push(text);
            void streamLive(false);
            scheduleFlush();
            return;
          }

          const thought = chunkTextOfKind(event.payload, "agent_thought_chunk");
          if (thought !== undefined) {
            state.thoughtBuffer.push(thought);
            void streamThought(false);
            return;
          }

          const record = foldToolUpdate(state.tools, event.payload);
          if (record !== null) {
            void streamTool(record);
            return;
          }

          const kind = isRecord(event.payload) ? event.payload.sessionUpdate : undefined;
          if (typeof kind === "string" && noteUnmappedKind(kind)) {
            log.info("a session update kind reaches Matrix and is not forwarded", {
              sessionId,
              kind,
            });
          }
          return;
        }
```

Clear the new per-turn state inside `flush`, next to the existing reset:

```ts
    state.thoughtBuffer = [];
    state.thoughtSeq = 0;
    state.thoughtSentChars = 0;
    state.thoughtSentAt = 0;
    state.tools = new Map();
    state.toolSeq = 0;
```

- [ ] **Step 8: Add `foldToolUpdate` and `ToolRecord` to `activity.ts`**

```ts
import type { ToolStatus } from "@agentpod/contract";

/** One tool call, accumulated across its `tool_call` and every update to it. */
export interface ToolRecord {
  id: string;
  title: string;
  kind: string | undefined;
  status: ToolStatus;
  locations: string[];
}

const TOOL_STATUSES: readonly string[] = ["pending", "in_progress", "completed", "failed"];

function toolStatus(value: unknown): ToolStatus | undefined {
  return typeof value === "string" && TOOL_STATUSES.includes(value)
    ? (value as ToolStatus)
    : undefined;
}

function locationPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (entry !== null && typeof entry === "object") {
      const path = (entry as Record<string, unknown>).path;
      if (typeof path === "string") out.push(path);
    }
  }
  return out;
}

/**
 * Folds a `tool_call` or `tool_call_update` into `tools`, returning the record
 * as it now stands — or `null` when the payload is neither.
 *
 * **Upsert, never append.** A repeated `toolCallId` merges, for the reason the
 * console records at `transcript.ts:299-305`: a buggy or hostile agent
 * repeating an id must not produce two records with one identity. An update
 * carrying only a status keeps the title it was given first, because a ticker
 * that forgets what it is doing halfway through is worse than one that is a
 * moment stale.
 */
export function foldToolUpdate(
  tools: Map<string, ToolRecord>,
  payload: unknown
): ToolRecord | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const kindOfUpdate = p.sessionUpdate;
  if (kindOfUpdate !== "tool_call" && kindOfUpdate !== "tool_call_update") return null;

  const id = typeof p.toolCallId === "string" ? p.toolCallId : undefined;
  // Nothing can merge onto a call with no id, and inventing one would make two
  // updates of the same call look like two calls.
  if (id === undefined) return null;

  const existing = tools.get(id);
  const record: ToolRecord = {
    id,
    title: typeof p.title === "string" ? p.title : (existing?.title ?? id),
    kind: typeof p.kind === "string" ? p.kind : existing?.kind,
    status: toolStatus(p.status) ?? existing?.status ?? "pending",
    locations: locationPaths(p.locations) ?? existing?.locations ?? [],
  };
  tools.set(id, record);
  return record;
}
```

Write its tests in `activity.test.ts` first, covering: a `tool_call` creates a record; a `tool_call_update` merges and keeps the title; a repeated `tool_call` id merges rather than duplicating; a missing id returns null; a non-tool payload returns null; insertion order is preserved across updates.

- [ ] **Step 9: Run the tests**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/hub/src/services/matrix-as/ packages/contract/
git commit -m "feat: stream an agent's thinking and tool use to the reader's devices"
```

---

## Task 4: The durable per-turn record

**Files:**
- Modify: `apps/hub/src/services/matrix-as/activity.ts` (+ its test)
- Modify: `apps/hub/src/services/matrix-as/client.ts`
- Modify: `apps/hub/src/services/matrix-as/outbound.ts` (+ its test)

**Interfaces:**
- Consumes: `ToolRecord`, `TurnActivity` (Tasks 2–3).
- Produces: `TURN_ACTIVITY_TYPE`, `turnActivityContent(sessionId, tools)`, `client.sendCustomEvent(userId, roomId, eventType, content)`.

- [ ] **Step 1: Write the failing test for the builder**

Append to `activity.test.ts`:

```ts
describe("the per-turn record", () => {
  function record(id: string, status: ToolStatus = "completed"): ToolRecord {
    return { id, title: `Do ${id}`, kind: "execute", status, locations: [] };
  }

  it("counts everything and lists what fits", () => {
    const tools = new Map([["a", record("a")], ["b", record("b", "failed")]]);
    const content = turnActivityContent("sess_1", tools);
    expect(content.counts).toEqual({ total: 2, failed: 1, omitted: 0 });
    expect(content.tools).toHaveLength(2);
    expect(content.schema_version).toBe(1);
  });

  it("caps the list and says how many it left out", () => {
    // A pathological turn must not produce an unbounded event; the counts still
    // tell the truth about the whole turn, so a capped list never reads as a
    // complete one.
    const tools = new Map(
      Array.from({ length: TURN_TOOLS_MAX + 5 }, (_, i) => [`t${i}`, record(`t${i}`)] as const),
    );
    const content = turnActivityContent("sess_1", tools);
    expect(content.tools).toHaveLength(TURN_TOOLS_MAX);
    expect(content.counts.total).toBe(TURN_TOOLS_MAX + 5);
    expect(content.counts.omitted).toBe(5);
  });

  it("keeps the order the tools were first used in", () => {
    const tools = new Map([["z", record("z")], ["a", record("a")]]);
    expect(turnActivityContent("sess_1", tools).tools.map((t) => t.id)).toEqual(["z", "a"]);
  });

  it("produces a body the contract accepts", () => {
    expect(TurnActivity.safeParse(turnActivityContent("sess_1", new Map([["a", record("a")]]))).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails, then implement**

Add to `activity.ts`:

```ts
/** The room event type carrying what an agent did during one turn. */
export const TURN_ACTIVITY_TYPE = "dev.agentpod.turn.v1";

/**
 * How many tool calls the durable record lists.
 *
 * A cap, not a sample: `counts` reports the whole turn regardless, so a capped
 * list is never mistaken for a complete one. Twenty is enough to read as a
 * record of what happened and small enough that one turn cannot produce an
 * event worth paginating around.
 */
export const TURN_TOOLS_MAX = 20;

/** The wire body for a turn's record. */
export function turnActivityContent(
  sessionId: string,
  tools: Map<string, ToolRecord>
): TurnActivity {
  const all = [...tools.values()];
  return {
    schema_version: 1,
    session_id: sessionId,
    tools: all.slice(0, TURN_TOOLS_MAX).map((t) => ({
      id: t.id,
      title: t.title,
      ...(t.kind === undefined ? {} : { kind: t.kind }),
      status: t.status,
      locations: t.locations,
    })),
    counts: {
      total: all.length,
      failed: all.filter((t) => t.status === "failed").length,
      omitted: Math.max(0, all.length - TURN_TOOLS_MAX),
    },
  };
}
```

- [ ] **Step 3: Add `sendCustomEvent` to `client.ts`**

Beside `sendText`, mirroring its transaction-id discipline:

```ts
    async sendCustomEvent(userId, roomId, eventType, content) {
      // A fresh transaction id per send, exactly as `sendText`: the homeserver
      // deduplicates on it, so reusing one silently drops a genuinely new event.
      const txn = `apb-${crypto.randomUUID()}`;
      const res = await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${txn}`,
        { method: "PUT", userId, body: content }
      );
      assertOkOrAlready("sendCustomEvent", res);
      return String(res.body.event_id ?? "") || null;
    },
```

Declare it on the client's interface and add it to `OutboundDeps["client"]` as **optional**, for the same reason `sendToDevice` is optional: a deployment without it simply does not send activity cards, and the room is otherwise identical.

- [ ] **Step 4: Write the failing behaviour test**

Append to `outbound.test.ts`:

```ts
describe("the durable record of a turn", () => {
  it("sends one activity event before the answer", async () => {
    // Reading order is the point: did these things, then said this.
    const { emit, sent, custom } = attachFixture();

    emit({ type: "agent-update", seq: 1, payload: { sessionUpdate: "tool_call", toolCallId: "c1", title: "Read a", status: "completed" } });
    emit({ type: "agent-update", seq: 2, payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } });
    emit({ type: "state", seq: 3, payload: { status: "idle" } });
    await flushMicrotasks();

    expect(custom).toHaveLength(1);
    expect(custom[0]?.eventType).toBe(TURN_ACTIVITY_TYPE);
    expect(custom[0]?.order).toBeLessThan(sent[0]?.order ?? Infinity);
  });

  it("sends nothing extra for a turn that used no tools", async () => {
    const { emit, sent, custom } = attachFixture();
    emit({ type: "agent-update", seq: 1, payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Just talking." } } });
    emit({ type: "state", seq: 2, payload: { status: "idle" } });
    await flushMicrotasks();

    expect(custom).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it("does not report the previous turn's work on the next turn", async () => {
    const { emit, custom } = attachFixture();
    emit({ type: "agent-update", seq: 1, payload: { sessionUpdate: "tool_call", toolCallId: "c1", title: "Read a", status: "completed" } });
    emit({ type: "state", seq: 2, payload: { status: "idle" } });
    await flushMicrotasks();
    emit({ type: "agent-update", seq: 3, payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Second turn." } } });
    emit({ type: "state", seq: 4, payload: { status: "idle" } });
    await flushMicrotasks();

    expect(custom).toHaveLength(1);
  });
});
```

`attachFixture` needs a `custom` array capturing `sendCustomEvent` calls, and both it and `sent` need a monotonic `order` stamped on capture so the ordering assertion is real rather than incidental.

- [ ] **Step 5: Implement the emit point**

In `outbound.ts`'s `flush`, before `await say(text)` and before the per-turn state is cleared:

```ts
    // Before the answer, so the room reads in the order things happened: did
    // these things, then said this. Best-effort like every other outbound call
    // here — a failed card must not cost the answer behind it.
    if (state.tools.size > 0 && deps.client.sendCustomEvent) {
      await deps.client
        .sendCustomEvent(agentUser, roomId, TURN_ACTIVITY_TYPE, turnActivityContent(sessionId, state.tools))
        .catch((err) => {
          log.error("could not record a turn's activity in its room", {
            sessionId,
            roomId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
```

Note the existing `if (text.trim() === "") return;` guard sits *after* this, so a turn that used tools and said nothing still records what it did.

- [ ] **Step 6: Run the tests, then commit**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
git add apps/hub/src/services/matrix-as/
git commit -m "feat: record what an agent did during a turn, once, in the room"
```

---

## Task 5: Structured approvals (hub side)

**Files:**
- Modify: `apps/hub/src/services/matrix-as/activity.ts` (+ test), `outbound.ts` (+ test)

- [ ] **Step 1: Failing test, then implement the builder**

```ts
/** The room event type carrying a permission request a client can render. */
export const PERMISSION_REQUEST_TYPE = "dev.agentpod.permission.v1";

/**
 * The wire body for a permission request, or `null` when there is nothing a
 * client could render.
 *
 * Capped at four options because supermessage's `DECISION_MAX_OPTIONS` renders
 * four and silently drops the rest — enforced here so the hub never sends
 * something it knows will be discarded. The prose message is **not** capped and
 * still lists every option: a fifth remains answerable by number or name, it
 * just does not get a button.
 */
export function permissionRequestContent(
  sessionId: string,
  requestSeq: number,
  title: string,
  options: readonly { optionId: string; name: string }[]
): PermissionRequestEvent | null {
  if (options.length === 0) return null;
  return {
    schema_version: 1,
    session_id: sessionId,
    request_seq: requestSeq,
    title,
    options: options.slice(0, 4).map((o) => ({ option_id: o.optionId, name: o.name })),
  };
}
```

- [ ] **Step 2: Emit it beside the prose**

In `outbound.ts`'s `permission-request` case, after the existing `await say(...)`:

```ts
          // Beside the prose, never instead of it. The prose is what keeps
          // Element and reply-by-number working, and the answer to either
          // arrives as an ordinary message through the same matcher.
          const structured = permissionRequestContent(
            sessionId,
            event.seq,
            request.title,
            request.options
          );
          if (structured && deps.client.sendCustomEvent) {
            await deps.client
              .sendCustomEvent(agentUser, roomId, PERMISSION_REQUEST_TYPE, structured)
              .catch(() => {});
          }
```

- [ ] **Step 3: Test that the prose is unchanged**

The regression that matters: a client that cannot read the custom event must be exactly as able to approve as it was before. Assert the prose message is still sent, still numbered, and still matched by `matchPermissionAnswer`.

- [ ] **Step 4: Run the suite and commit**

---

## Task 6: supermessage — receive the live channels

**Files:**
- Modify: `supermessage/src-tauri/src/core/live.rs`, `src/lib/ipc.ts`, `src/lib/stores/live.svelte.ts`

- [ ] **Step 1: Two more ruma event contents, mirroring `StreamDeltaToDeviceEventContent`**

```rust
#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "dev.agentpod.thought.delta", kind = ToDevice)]
pub struct ThoughtDeltaToDeviceEventContent { /* same fields as the stream delta */ }

#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "dev.agentpod.tool.update", kind = ToDevice)]
pub struct ToolUpdateToDeviceEventContent { /* room_id, session_id, seq, tool_call_id, title, kind, status, locations */ }
```

Register both handlers in `listen`, forwarding on two new channels (`sm://thought`, `sm://tool`). Reuse `LiveState`'s `supersedes`/`starts_new_turn` for the thought channel unchanged — that is why the shape was reused.

- [ ] **Step 2: Tests**

`live.rs`'s existing pure tests are the template: a later seq supersedes an earlier one; a seq of 1 starts a new turn; a duplicate is dropped. Add one asserting the two channels do not share state, so an agent thinking and answering at once cannot have one overwrite the other.

- [ ] **Step 3: Store and IPC**

Extend `live.svelte.ts` with a second keyed record for thought text and a third for tool records keyed by `tool_call_id` (upsert by id, exactly as the hub does). `pacer.ts` is reused for the thought text with no change.

- [ ] **Step 4: `cargo fmt` LAST, then commit**

---

## Task 7: supermessage — render the room events

**Files:**
- Modify: `src/lib/components/customEvents.ts` (+ test), `Timeline.svelte`

- [ ] **Step 1: The turn-activity renderer**

Registered on `customEventRegistry`, following `demoNoteRenderer` exactly. Reads `counts` and `tools` one level at a time; returns `fields` only — no decision. `maxKnownSchemaVersion: 1`.

Tests, following `customEvents.test.ts`: a well-formed payload; a higher `schema_version` (must still render, flagged `newerVersion`); a hostile payload with nested objects where strings are expected (must degrade, never coerce); an empty `tools` array.

- [ ] **Step 2: The permission renderer, which sets a decision**

Returns `fields` plus `decision`, where each `CustomEventDecisionOption.id` is the option's **name**, not its `option_id` — `id` is what `onDecide` receives verbatim and what will be sent, and the room transcript should read `Allow once`, not `allow_once`. `permissionPrompt`'s own doc comment is the argument: names are printed *"because '1' alone would make the transcript unreadable afterwards"*.

This trips the existing guard test `keeps the shipped demo renderer decision-free` only if the demo renderer is touched — it must not be.

- [ ] **Step 3: Make `onDecide` send**

Replace the `console.warn` stub at `Timeline.svelte:865`:

```ts
  function onDecide(itemId: string, optionId: string): void {
    void timelineStore.send(roomId, optionId).catch((err: unknown) => {
      console.error("failed to send a decision", { itemId, optionId, err });
    });
  }
```

`optionId` here carries the option's name, per Step 2.

- [ ] **Step 4: Add the type to `DECISION_BEARING_EVENT_TYPES`**

`dev.agentpod.permission.v1`. Read that constant's doc comment first: **reason 2 still holds** — the SDK's latest-event builder swallows `_Custom`, so `RoomSummary.lastEventType` is `null` and the roster's amber row remains unreachable. Adding the entry is correct and changes nothing visible; the doc comment must be updated to say so rather than left claiming the set is empty.

- [ ] **Step 5: `pnpm check && pnpm test && pnpm build`, then commit**

---

## Task 8: Verify against the live fleet

Per the repo's standing rule: features touching the live fleet are verified against the real deployment before their issue closes.

- [ ] Deploy the hub, talk to an agent on `ashram` that uses tools, and confirm: tool updates arrive to-device while it works; one activity card lands before the answer; a second turn does not repeat the first's tools; an approval renders buttons and tapping one resolves it.
- [ ] Check the hub log for `a session update kind reaches Matrix and is not forwarded` — whatever it names is the next thing worth forwarding, and it is now visible for the first time.
