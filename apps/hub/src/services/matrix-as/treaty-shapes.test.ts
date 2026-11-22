/**
 * Every Matrix shape the hub emits, held to treaty's schemas (treaty phase 2, ruling 6):
 * `agentpod.matrix-activity`, which this hub produces. The bodies come from the hub's own builders,
 * across the inputs that change their shape, and each must validate against
 * `schemas/matrix/<type>.json` as published in the pinned treaty release.
 *
 * - `dev.agentpod.turn.v1` (room event): `turnActivityContent`;
 * - `dev.agentpod.stream.delta` and `dev.agentpod.thought.delta` (to-device): `deltaContent`;
 * - `dev.agentpod.tool.update` (to-device): `toolUpdateContent`;
 * - `dev.agentpod.turn_error` (content key on `m.text`): `turnErrorCard`;
 * - `dev.agentpod.voice_transcript` (content key on `m.notice`): `transcriptContent`;
 * - `dev.agentpod.voice_reply` (content key on `m.audio`): `voiceReplyContent`.
 */
import { describe, expect, test } from "bun:test";
import { TURN_ERROR_CONTENT_KEY, TurnErrorKind, VOICE_REPLY_CONTENT_KEY, VOICE_TRANSCRIPT_CONTENT_KEY } from "@agentpod/contract";
import { validatorFor } from "@superjackfruitlabs/treaty-contracts";
import { loadInstalledBundle } from "@superjackfruitlabs/treaty-contracts/node";

import { treatyText } from "../../../tests/helpers/treaty-data";

import {
  turnErrorCard,
  turnErrorForSilentTurn,
  turnErrorForUnreachableGateway,
  turnErrorFromPlugin,
  turnErrorFromReason,
} from "../acp/turn-error";
import { TURN_ACTIVITY_TYPE, TURN_TOOLS_MAX, foldToolUpdate, turnActivityContent, type ToolRecord } from "./activity";
import { LIVE_DELTA_TYPE, THOUGHT_DELTA_TYPE, TOOL_UPDATE_TYPE, deltaContent, toolUpdateContent } from "./live";
import { transcriptContent } from "./voice";
import { voiceReplyContent } from "./voice-reply";

const bundle = loadInstalledBundle();

/** The schema a shape is held to, with the carrier treaty says it travels on. */
function schema(type: string): { check: (v: unknown) => { valid: boolean; errors: string[] }; carrier: unknown } {
  const path = `schemas/matrix/${type}.json`;
  const doc: Record<string, unknown> = JSON.parse(treatyText(path));
  return { check: validatorFor(bundle, path), carrier: doc["x-treaty-carrier"] };
}

function expectValid(type: string, body: unknown) {
  const result = schema(type).check(body);
  expect({ type, body, errors: result.errors }).toEqual({ type, body, errors: [] });
}

const tools = (n: number, over: Partial<ToolRecord> = {}): Map<string, ToolRecord> =>
  new Map(
    Array.from({ length: n }, (_, i) => [
      `tc_${i}`,
      { id: `tc_${i}`, title: `Read file ${i}`, kind: "read", status: "completed", locations: [`/src/${i}.ts`], ...over },
    ]),
  );

describe("the turn card", () => {

  test("travels as a room event", () => {
    expect(schema(TURN_ACTIVITY_TYPE).carrier).toEqual({ kind: "room-event" });
  });

  test("a turn with no tools, one of each status, and one over the cap", () => {
    expectValid(TURN_ACTIVITY_TYPE, turnActivityContent("ses_1", new Map()));
    for (const status of ["pending", "in_progress", "completed", "failed"] as const) {
      expectValid(TURN_ACTIVITY_TYPE, turnActivityContent("ses_1", tools(2, { status })));
    }
    const capped = turnActivityContent("ses_1", tools(TURN_TOOLS_MAX + 5));
    expect(capped.counts.omitted).toBe(5);
    expectValid(TURN_ACTIVITY_TYPE, capped);
  });

  test("a tool the harness gave no kind, title or locations (the folded record)", () => {
    const m = new Map<string, ToolRecord>();
    foldToolUpdate(m, { sessionUpdate: "tool_call", toolCallId: "tc_bare" });
    foldToolUpdate(m, { sessionUpdate: "tool_call_update", toolCallId: "tc_bare", status: "failed", locations: [] });
    expectValid(TURN_ACTIVITY_TYPE, turnActivityContent("ses_2", m));
  });
});

describe("the deltas", () => {
  test("travel to-device", () => {
    for (const type of [LIVE_DELTA_TYPE, THOUGHT_DELTA_TYPE, TOOL_UPDATE_TYPE]) {
      expect(schema(type).carrier).toMatchObject({ kind: "to-device" });
    }
  });

  test("an answer and a thought, mid-turn and at its end", () => {
    for (const type of [LIVE_DELTA_TYPE, THOUGHT_DELTA_TYPE]) {
      for (const done of [false, true]) {
        expectValid(type, deltaContent({ roomId: "!r:hs", sessionId: "ses_1", seq: 3, text: "So far, so good.", done }));
      }
      expectValid(type, deltaContent({ roomId: "!r:hs", sessionId: "ses_1", seq: 0, text: "", done: true }));
    }
  });

  test("a tool update, with and without a kind, in every status", () => {
    for (const status of ["pending", "in_progress", "completed", "failed"] as const) {
      for (const kind of ["execute", undefined]) {
        expectValid(
          TOOL_UPDATE_TYPE,
          toolUpdateContent({ roomId: "!r:hs", sessionId: "ses_1", seq: 1, toolCallId: "tc_1", title: "Run tests", kind, status, locations: [] }),
        );
      }
    }
  });
});

describe("the error card", () => {
  test("rides on m.text under its content key", () => {
    expect(schema(TURN_ERROR_CONTENT_KEY).carrier).toMatchObject({ kind: "content-key", msgtype: "m.text" });
  });

  test("every kind the hub names, from each place an error comes from", () => {
    const cards = [
      turnErrorCard(turnErrorForUnreachableGateway("openclaw")),
      turnErrorCard(turnErrorForSilentTurn("pi", "max_tokens")),
      turnErrorCard(turnErrorForSilentTurn("pi", "something-new")),
      turnErrorCard(turnErrorFromReason("the node went offline", "hermes", "hub")),
      turnErrorCard(
        turnErrorFromPlugin(
          {
            message: "Rate limited by the provider",
            kind: "rate_limit",
            provider: "anthropic",
            model: "claude",
            httpStatus: 429,
            retryable: true,
            attempts: [
              { provider: "anthropic", model: "claude", message: "429 Too Many Requests" },
              { provider: "openai", model: "gpt", message: "quota exceeded" },
            ],
          },
          "openclaw",
        ),
      ),
      ...TurnErrorKind.options.map((kind) => turnErrorCard({ kind, message: `A ${kind} error`, harness: "codex" })),
      turnErrorCard({ kind: "unknown", message: "x".repeat(10_000), harness: "h".repeat(500), provider: "p".repeat(500) }),
    ];
    expect(cards.every((c) => c !== null)).toBe(true);
    for (const card of cards) expectValid(TURN_ERROR_CONTENT_KEY, card);
  });
});

describe("the voice keys", () => {
  test("ride on m.notice and m.audio", () => {
    expect(schema(VOICE_TRANSCRIPT_CONTENT_KEY).carrier).toMatchObject({ kind: "content-key", msgtype: "m.notice" });
    expect(schema(VOICE_REPLY_CONTENT_KEY).carrier).toMatchObject({ kind: "content-key", msgtype: "m.audio" });
  });

  test("a transcript, with and without its language and length, and one past every bound", () => {
    for (const [transcript, seconds] of [
      [{ text: "Ship it.", language: "en" }, 2.4],
      [{ text: "Ship it.", language: null }, null],
      [{ text: "y".repeat(30_000), language: "x".repeat(40) }, 99_999],
    ] as const) {
      const content = transcriptContent(transcript, seconds);
      expectValid(VOICE_TRANSCRIPT_CONTENT_KEY, content[VOICE_TRANSCRIPT_CONTENT_KEY]);
    }
  });

  test("a spoken reply, plain and encrypted, with and without its duration", () => {
    const medias: Array<Parameters<typeof voiceReplyContent>[0]["media"]> = [
      { url: "mxc://hs/abc" },
      {
        file: {
          url: "mxc://hs/enc",
          key: { kty: "oct", key_ops: ["encrypt", "decrypt"], alg: "A256CTR", k: "k", ext: true },
          iv: "iv",
          hashes: { sha256: "h" },
          v: "v2",
        },
      },
    ];
    for (const media of medias) {
      for (const durationMs of [4_200, null]) {
        const content = voiceReplyContent({
          media,
          size: 12_345,
          durationMs,
          waveform: durationMs === null ? null : [0, 512, 1024],
          textEventId: "$text",
          voice: "bm_lewis",
        });
        expect(content.msgtype).toBe("m.audio");
        expectValid(VOICE_REPLY_CONTENT_KEY, content[VOICE_REPLY_CONTENT_KEY]);
      }
    }
  });
});
