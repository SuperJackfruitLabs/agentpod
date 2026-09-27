// Unit tests for the agentpod-errors Pi extension:
//   node --experimental-strip-types --test test/*.test.mjs
//
// Event shapes are exactly what Pi delivered to a probe extension on
// 2026-09-26, driven over ACP by pi-acp (as the AgentPod node drives it)
// against a fake provider, on Pi 0.84.1 / pi-acp 0.0.33 and 0.87.1 / 0.0.34:
//  - a failed attempt is message_end with role "assistant", stopReason
//    "error", and errorMessage "403 {json body}";
//  - Pi's own retries give one such message_end per attempt;
//  - agent_settled fires once, after the last.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import extension, { attemptFrom, createReporter, socketPath, MAX_ATTEMPTS } from "../index.ts";

const QUOTA = '403 {"type":"error","error":{"type":"permission_error","message":"You\'ve reached your weekly (7-day) usage limit."}}';
const OVERLOADED = '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

const failed = (errorMessage, model = "quota") => ({
  message: { role: "assistant", stopReason: "error", errorMessage, provider: "fakeq", model, api: "anthropic-messages", content: [] },
});
const answered = { message: { role: "assistant", stopReason: "stop", provider: "fakeq", model: "quota", content: [{ type: "text", text: "Yes." }] } };

test("a failed attempt reads as its sentence, status and type", () => {
  assert.deepEqual(attemptFrom(failed(QUOTA)), {
    provider: "fakeq",
    model: "quota",
    message: "You've reached your weekly (7-day) usage limit.",
    providerErrorType: "permission_error",
    httpStatus: 403,
  });
});

test("an answer, a user message, and a tool result are not attempts", () => {
  assert.equal(attemptFrom(answered), null);
  assert.equal(attemptFrom({ message: { role: "user", content: "hi" } }), null);
  assert.equal(attemptFrom({ message: { role: "toolResult" } }), null);
  assert.equal(attemptFrom({}), null);
});

test("socketPath matches the node's", () => {
  assert.equal(socketPath({}, "/home/openclaw"), "/home/openclaw/.agentpod/turn-errors.sock");
  assert.equal(socketPath({ AGENTPOD_TURN_ERROR_SOCKET: "/run/x.sock" }, "/h"), "/run/x.sock");
});

function fakeIntake(t) {
  const dir = fs.mkdtempSync(path.join(os.platform() === "darwin" ? "/tmp" : os.tmpdir(), "pie-"));
  const sock = path.join(dir, "s.sock");
  const lines = [];
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) {
        lines.push(JSON.parse(buf.split("\n")[0]));
        c.end("ok\n");
      }
    });
  });
  server.listen(sock);
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { sock, lines };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("Pi's retries, then settled: one report of every attempt, keyed by the hub session", async (t) => {
  const { sock, lines } = fakeIntake(t);
  const r = createReporter({ socket: sock, session: "acps_0f3c" });
  r.onMessageEnd(failed(OVERLOADED, "flaky"));
  r.onMessageEnd(failed(OVERLOADED, "flaky"));
  r.onMessageEnd(failed(OVERLOADED, "flaky"));
  await r.onSettled();
  await sleep(50);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].acpSessionId, "acps_0f3c");
  assert.equal(lines[0].error.message, "Overloaded");
  assert.equal(lines[0].error.httpStatus, 529);
  assert.equal(lines[0].error.attempts.length, 3);
});

test("a retry that answered clears the failures before it", async (t) => {
  const { sock, lines } = fakeIntake(t);
  const r = createReporter({ socket: sock, session: "acps_0f3c" });
  r.onMessageEnd(failed(OVERLOADED, "flaky"));
  r.onMessageEnd(answered);
  await r.onSettled();
  await sleep(50);
  assert.equal(lines.length, 0);
});

test("settled with nothing failed sends nothing, and a second turn starts clean", async (t) => {
  const { sock, lines } = fakeIntake(t);
  const r = createReporter({ socket: sock, session: "acps_0f3c" });
  await r.onSettled();
  r.onMessageEnd(failed(QUOTA));
  await r.onSettled();
  r.onMessageEnd(failed(QUOTA));
  await r.onSettled();
  await sleep(50);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].error.attempts.length, 1);
});

test("without a hub session there is nothing to report to", async (t) => {
  const { sock, lines } = fakeIntake(t);
  const r = createReporter({ socket: sock, session: undefined });
  r.onMessageEnd(failed(QUOTA));
  await r.onSettled();
  await sleep(50);
  assert.equal(lines.length, 0);
});

test("never more attempts than the contract takes: the first and the latest are kept", async (t) => {
  const { sock, lines } = fakeIntake(t);
  const r = createReporter({ socket: sock, session: "acps_0f3c" });
  r.onMessageEnd(failed(QUOTA, "first"));
  for (let i = 0; i < 30; i++) r.onMessageEnd(failed(OVERLOADED, `m${i}`));
  await r.onSettled();
  await sleep(50);
  const attempts = lines[0].error.attempts;
  assert.equal(attempts.length, MAX_ATTEMPTS);
  assert.equal(attempts[0].model, "first");
  assert.equal(attempts.at(-1).model, "m29");
});

test("no node listening costs Pi nothing", async () => {
  const warnings = [];
  const r = createReporter({ socket: "/tmp/no-such-agentpod.sock", session: "acps_0f3c", logger: { warn: (m) => warnings.push(m) } });
  r.onMessageEnd(failed(QUOTA));
  await r.onSettled();
  r.onMessageEnd(failed(QUOTA));
  await r.onSettled();
  assert.equal(warnings.length, 1);
});

test("the extension registers message_end and agent_settled, and nothing that changes a turn", () => {
  const registered = [];
  extension({ on: (name) => registered.push(name) });
  assert.deepEqual(registered.sort(), ["agent_settled", "message_end"]);
});
