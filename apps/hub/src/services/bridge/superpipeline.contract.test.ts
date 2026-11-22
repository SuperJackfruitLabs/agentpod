/**
 * The SuperPipeline client against treaty's contracts for the two APIs it calls.
 *
 * `agent-work.v1` and `decisions.v1` (`@superjackfruitlabs/treaty-contracts`) hold valid response
 * bodies for every operation, written from SuperPipeline's handlers and validated by SuperPipeline's
 * own tests against what it serves. Each one goes through the client's real parsing here, so a body
 * the board really sends cannot be one this hub fails to read. Every error code an operation lists
 * comes back as a `SuperpipelineApiError` with that code and the registry's status, and so does
 * every valid `error.v1` envelope. The requests are held to the same contracts (`contractFetch`).
 */
import { describe, expect, test } from "bun:test";

import { SuperpipelineApiError, SuperpipelineClient } from "./superpipeline";
import { CARD_CHOICE_CHECKPOINT_PROTOCOLS, CHECKPOINT_CLAIM_PROTOCOL } from "./checkpoint-claim";
import { contractFetch, errorCodesOf, errorEnvelopeCases, validResponses } from "../../../tests/helpers/superpipeline-contract";
import { takeContractViolations } from "../../../tests/helpers/superpipeline-contract-violations";

const BOARD = "brd_9c1d4e5f6a7b8c9d";
const TOKEN = `spa_${"a1b2c3d4".repeat(6)}`;
const RUN = "run_8d2e4b19c6a07f53";
const LEASE = { runId: RUN, leaseEpoch: 1 };

/** A client whose board answers every request with `status` and `body`, after the request is checked. */
function board(status: number, body: unknown, boardId = BOARD) {
  const ops: string[] = [];
  const fetch = contractFetch(async () => ({ status, ok: status >= 200 && status < 300, json: async () => body }), ops);
  return { ops, client: new SuperpipelineClient({ baseUrl: "https://board.test", boardId, token: TOKEN, fetch }) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const field = (v: unknown, key: string): unknown => (isRecord(v) ? v[key] : undefined);

/**
 * Each operation the hub calls, and the client call that reaches it. `check` asserts what the
 * client read from a valid body, beyond its not throwing.
 */
const CALLS: Record<string, { call: (client: SuperpipelineClient, body: unknown) => Promise<unknown>; check?: (got: unknown, body: unknown) => void }> = {
  claimCard: {
    // A stage whose cards choose is offered only to a claimant that asked for claim protocol v2.
    call: (c, body) =>
      isRecord(field(field(body, "stage"), "cardCheckpointPolicy"))
        ? c.claim({ checkpointProtocol: CHECKPOINT_CLAIM_PROTOCOL, checkpointProtocols: CARD_CHOICE_CHECKPOINT_PROTOCOLS })
        : isRecord(field(body, "checkpointClaim"))
          ? c.claim({ checkpointProtocol: CHECKPOINT_CLAIM_PROTOCOL })
          : c.claim(),
    check: (got, body) => {
      if (field(body, "claimed") === true) expect(field(got, "runId")).toBe(field(body, "runId"));
      else expect(got).toBeNull();
    },
  },
  readRun: {
    call: (c) => c.context(RUN),
    check: (got, body) => {
      expect(field(field(got, "card"), "id")).toBe(field(field(body, "card"), "id"));
      expect(field(got, "references")).toEqual(field(body, "references"));
    },
  },
  readRunAttempts: { call: (c) => c.attempts(RUN), check: (got, body) => expect(got).toEqual(body) },
  heartbeatRun: { call: (c) => c.heartbeat(LEASE) },
  postRunActivity: {
    call: (c, body) => {
      const strict = field(field(body, "activity"), "strictDecision");
      return isRecord(strict)
        ? c.activity(LEASE, {
            type: "elicitation",
            signal: "select",
            body: "Push the release branch?",
            parameter: { options: [{ name: "approve", title: "Approve" }, { name: "deny", title: "Deny" }] },
            strictDecision: {
              version: 1,
              request_id: String(field(strict, "request_id")),
              decision_digest: String(field(strict, "decision_digest")),
              expires_at: Number(field(strict, "expires_at")),
            },
          })
        : c.activity(LEASE, { type: "thought", body: "Reading the merged pull requests" });
    },
  },
  completeRun: { call: (c) => c.complete(LEASE, { summary: "done" }) },
  submitRun: { call: (c) => c.submitForReview(LEASE, { summary: "ready" }) },
  blockRun: { call: (c) => c.block(LEASE, "needs a human") },
  failRun: { call: (c) => c.fail(LEASE, "harness died") },
  releaseRun: { call: (c) => c.release(LEASE) },
  addRunReference: {
    call: (c) => c.addRunReference(LEASE, { url: "https://library.test/a/itm_1", title: "answer.md", provider: "superlibrary" }),
  },
  addRunEvidenceReference: {
    call: (c) =>
      c.addEvidenceReference(RUN, {
        leaseEpoch: 1,
        cardId: "card_3f9a1c07b2e84d65",
        stageKey: "draft",
        export_id: "11111111-1111-4111-8111-111111111111",
        manifest_sha256: "a".repeat(64),
      }),
    check: (got, body) => expect(field(got, "reference_id")).toBe(field(body, "reference_id")),
  },
  readGate: {
    call: (c) => c.gate("gate_4e8b1c2d3f4a5b6c"),
    check: (got, body) => {
      expect(got).not.toBeNull();
      expect(field(got, "status")).toBe(field(field(body, "gate"), "status"));
    },
  },
  listPendingGates: { call: (c) => c.pendingGates(), check: (got, body) => expect(got).toEqual(field(body, "gates")) },
  listPendingElicitations: {
    call: (c) => c.pendingElicitations(),
    check: (got, body) => expect(got).toEqual(field(body, "elicitations")),
  },
  listPendingDeliveries: { call: (c) => c.pendingDeliveries(), check: (got, body) => expect(got).toEqual(field(body, "deliveries")) },
  listPendingAttention: { call: (c) => c.pendingAttention(), check: (got, body) => expect(got).toEqual(field(body, "attention")) },
  readCardChecks: {
    call: (c) => c.cardChecks("card_3f9a1c07b2e84d65"),
    check: (got, body) => {
      if (field(body, "checks") === null) expect(got).toBeNull();
      else expect(field(got, "status")).toBe(field(field(body, "checks"), "status"));
    },
  },
};

/** The board id a body binds, for a claim whose checkpoint discovery names its board. */
function boardOf(body: unknown): string {
  const named = field(field(body, "checkpointClaim"), "boardId");
  return typeof named === "string" ? named : BOARD;
}

describe("every valid response the contracts hold is read by the client", () => {
  for (const [operationId, { call, check }] of Object.entries(CALLS)) {
    for (const [name, body] of validResponses(operationId)) {
      test(`${operationId}: ${name}`, async () => {
        const { client, ops } = board(200, body, boardOf(body));
        const got = await call(client, body);
        expect(ops).toEqual([operationId]);
        check?.(got, body);
      });
    }
  }
});

describe("every error an operation lists comes back as its code", () => {
  for (const [operationId, { call }] of Object.entries(CALLS)) {
    test(operationId, async () => {
      for (const { code, status } of errorCodesOf(operationId)) {
        const { client } = board(status, { error: { code, message: "refused" } });
        const err: unknown = await call(client, {}).then(
          (v) => v,
          (e: unknown) => e,
        );
        // `gate()` reads a refusal as "could not read it": never as a decision.
        if (operationId === "readGate") {
          expect(err).toBeNull();
          continue;
        }
        expect(err).toBeInstanceOf(SuperpipelineApiError);
        if (!(err instanceof SuperpipelineApiError)) continue;
        expect({ code: err.code, status: err.status }).toEqual({ code, status });
      }
    });
  }

  test("every valid error.v1 envelope gives its code, whatever else the body carries", async () => {
    for (const [name, body] of Object.entries(errorEnvelopeCases.valid)) {
      const { client } = board(409, body);
      const err: unknown = await client.heartbeat(LEASE).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(SuperpipelineApiError);
      const code: unknown = err instanceof SuperpipelineApiError ? err.code : undefined;
      expect(code, name).toBe(field(field(body, "error"), "code"));
    }
  });

  test("a body that is not error.v1 is still a refusal, with no code it did not give", async () => {
    for (const { why, body } of errorEnvelopeCases.invalid) {
      const { client } = board(409, body);
      const err: unknown = await client.heartbeat(LEASE).catch((e: unknown) => e);
      expect(err, why).toBeInstanceOf(SuperpipelineApiError);
      const code = err instanceof SuperpipelineApiError ? err.code : undefined;
      const given = field(field(body, "error"), "code");
      expect(code === null || code === given, why).toBe(true);
    }
  });
});

describe("the contract check itself", () => {
  test("a request that reaches no operation fails, and so does a body its operation refuses", async () => {
    // Subscribing to push (`POST …/push-configs`) is not in either contract yet: a test that sends
    // it through a checked fake fails rather than passing against a route nobody describes.
    const { client } = board(200, { configId: "pcf_1" });
    await expect(client.registerPushConfig({ url: "https://hub.test/push", token: "k", events: ["gate.pending"] })).rejects.toThrow(
      /reaches no operation/,
    );
    await expect(board(200, { claimed: false, reason: "no_matching_card" }).client.claim({ maxConcurrency: 0 })).rejects.toThrow(
      /claimCard\) sent a body its contract refuses/,
    );
    // Both were kept for the global check too; taken here, since this test means to send them.
    expect(takeContractViolations()).toHaveLength(2);
  });
});
