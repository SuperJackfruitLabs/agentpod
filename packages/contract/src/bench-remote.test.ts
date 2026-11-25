/**
 * The same bodies as the node's `internal/benchremote` TestVerbsStrictDecode
 * (`fixtures/bench-remote-v1.json`): what one side accepts the other accepts, and an unknown field
 * is refused by both.
 */
import { expect, test } from "bun:test";
import type { z } from "zod";
import fixture from "./fixtures/bench-remote-v1.json";
import {
  BenchIdentityEnsureReply, BenchIdentityEnsureRequest, BenchRemoteAttachReply, BenchRemoteAttachRequest,
  BenchRemoteDetachReply, BenchRemoteDetachRequest, BenchRemoteStatusReply, BenchRemoteStatusRequest, NodeCapability,
} from "./index";

const requests: Record<string, z.ZodTypeAny> = {
  "bench.identity.ensure": BenchIdentityEnsureRequest,
  "bench.remote.attach": BenchRemoteAttachRequest,
  "bench.remote.detach": BenchRemoteDetachRequest,
  "bench.remote.status": BenchRemoteStatusRequest,
};
const replies: Record<string, z.ZodTypeAny> = {
  "bench.identity.ensure": BenchIdentityEnsureReply,
  "bench.remote.attach": BenchRemoteAttachReply,
  "bench.remote.detach": BenchRemoteDetachReply,
  "bench.remote.status": BenchRemoteStatusReply,
};

test("every valid request body parses", () => {
  for (const [verb, body] of Object.entries(fixture.valid)) expect(requests[verb]!.parse(body)).toEqual(body);
});

test("every invalid request body is refused", () => {
  expect(fixture.invalid.length).toBeGreaterThan(0);
  for (const c of fixture.invalid) expect([c.verb, c.why, requests[c.verb]!.safeParse(c.params).success]).toEqual([c.verb, c.why, false]);
});

test("replies parse, and a refusal parses as every verb's reply", () => {
  for (const [verb, schema] of Object.entries(replies)) {
    expect(schema.safeParse(fixture.replies[verb as keyof typeof fixture.replies]).success).toBe(true);
    expect(schema.safeParse(fixture.replies.refused).success).toBe(true);
  }
  expect(BenchRemoteDetachReply.safeParse({ state: "gone" }).success).toBe(false);
});

test("the capability is a known one", () => {
  expect(NodeCapability.parse("bench.remote.attach")).toBe("bench.remote.attach");
});
