/**
 * The decisions chat writes back to a board, against treaty's `decisions.v1`.
 *
 * Each write-back helper (a gate decided, a held approval pulled back, a check overridden, a
 * delivery's live link, a waiting card resumed or archived, a question answered) sends a request
 * the contract describes (`contractWebFetch`); every valid 200 the contract holds for that
 * operation reads as done; every error code the operation lists reads as that code, and so does
 * every valid `error.v1` envelope, whatever else it carries.
 */
import { describe, expect, test } from "bun:test";

import {
  answerAttentionAtSuperpipeline,
  overrideCheckAtSuperpipeline,
  pullBackAtSuperpipeline,
  resolveGateAtSuperpipeline,
  updateDeliveryAtSuperpipeline,
} from "./gate-resolve";
import { answerElicitationAtSuperpipeline } from "./elicitations";
import { contractWebFetch, errorCodesOf, errorEnvelopeCases, validResponses } from "../../../tests/helpers/superpipeline-contract";

const BOARD = "brd_9c1d4e5f6a7b8c9d";
const CARD = "card_3f9a1c07b2e84d65";
const WHO = { principalId: "prn_4e2a9c1f7b3d0e58aa11", senderMxid: "@rakesh:id.agentpod.dev" };
const SUBJECT = {
  id: "aps_7d6c5b4a39281706",
  digest: "sha256:4f2a0c1e9b8d7f6a5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7",
};

type Outcome = { ok: true } | { ok: false; code: string };
type Deps = { baseUrl: string; mint(): Promise<string>; fetch: typeof fetch };

/** A board that answers `status` and `body`, after the request is held to the contract. */
function board(status: number, body: unknown): { deps: Deps; ops: string[] } {
  const ops: string[] = [];
  const answer = (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  return { ops, deps: { baseUrl: "https://board.test", mint: async () => "assertion", fetch: contractWebFetch(answer, ops) } };
}

/** An `error.v1` body's code. */
function codeOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const e: unknown = body.error;
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

/** Every write the hub makes, by the operation it reaches. */
const WRITES: Array<[string, string, (deps: Deps) => Promise<Outcome>]> = [
  ["resolveGate", "a decision", (d) => resolveGateAtSuperpipeline({ boardId: BOARD, gateId: "gate_4e8b1c2d3f4a5b6c", decision: "approve", comment: null, ...WHO }, d)],
  [
    "resolveGate",
    "a decision on a bound subject, with a comment",
    (d) =>
      resolveGateAtSuperpipeline(
        { boardId: BOARD, gateId: "gate_4e8b1c2d3f4a5b6c", decision: "approve_manual", comment: "Ship it.", approvalSubject: SUBJECT, ...WHO },
        d,
      ),
  ],
  ["pullBackGate", "a pull-back", (d) => pullBackAtSuperpipeline({ boardId: BOARD, gateId: "gate_4e8b1c2d3f4a5b6c", comment: "Wait for the launch.", ...WHO }, d)],
  [
    "overrideCardCheck",
    "an override",
    (d) => overrideCheckAtSuperpipeline({ boardId: BOARD, cardId: CARD, checkName: "lint", comment: "Flaky; checked by hand.", ...WHO }, d),
  ],
  [
    "setGateDelivery",
    "a live link",
    (d) => updateDeliveryAtSuperpipeline({ boardId: BOARD, gateId: "gate_4e8b1c2d3f4a5b6c", change: { liveUrl: "https://example.com/posts/1" }, ...WHO }, d),
  ],
  [
    "setGateDelivery",
    "automatic delivery",
    (d) => updateDeliveryAtSuperpipeline({ boardId: BOARD, gateId: "gate_4e8b1c2d3f4a5b6c", change: { mode: "automatic" }, ...WHO }, d),
  ],
  [
    "resumeCard",
    "a resume at an earlier stage",
    (d) =>
      answerAttentionAtSuperpipeline(
        { boardId: BOARD, cardId: CARD, waitId: "wait_3c4d5e6f7a8b9c0d", action: { kind: "resume", toStageKey: "research", comment: "Start again." }, ...WHO },
        d,
      ),
  ],
  [
    "archiveCard",
    "an archive with no remark",
    (d) => answerAttentionAtSuperpipeline({ boardId: BOARD, cardId: CARD, waitId: "wait_3c4d5e6f7a8b9c0d", action: { kind: "archive", comment: null }, ...WHO }, d),
  ],
  ["answerElicitation", "an option", (d) => answerElicitationAtSuperpipeline({ boardId: BOARD, elicitationId: "elc_a41f09c3e7b25d86", option: "a", ...WHO }, d)],
  ["answerElicitation", "free text", (d) => answerElicitationAtSuperpipeline({ boardId: BOARD, elicitationId: "elc_a41f09c3e7b25d86", text: "The 2026 survey.", ...WHO }, d)],
  [
    "answerElicitation",
    "an approval of a bound question",
    (d) => answerElicitationAtSuperpipeline({ boardId: BOARD, elicitationId: "elc_a41f09c3e7b25d86", option: "allow_once", subject: SUBJECT, ...WHO }, d),
  ],
  [
    "answerElicitation",
    "an answer to a broker approval request",
    (d) => answerElicitationAtSuperpipeline({ boardId: BOARD, elicitationId: "apr_5e6f7a8b9c0d1e2f", option: "deny", ...WHO }, d),
  ],
];

describe("chat's write-backs, held to decisions.v1", () => {
  for (const [operationId, what, write] of WRITES) {
    test(`${operationId}: ${what} is a request the contract describes, and every valid answer is done`, async () => {
      for (const [name, body] of validResponses(operationId)) {
        const { deps, ops } = board(200, body);
        expect(await write(deps), name).toEqual({ ok: true });
        expect(ops).toEqual([operationId]);
      }
    });

    test(`${operationId}: ${what}, refused, reads as the board's own code`, async () => {
      for (const { code, status } of errorCodesOf(operationId)) {
        expect(await write(board(status, { error: { code, message: "refused" } }).deps)).toEqual({ ok: false, code });
      }
      for (const [name, body] of Object.entries(errorEnvelopeCases.valid)) {
        const got: unknown = await write(board(409, body).deps);
        expect(got, name).toEqual({ ok: false, code: codeOf(body) });
      }
    });
  }
});
