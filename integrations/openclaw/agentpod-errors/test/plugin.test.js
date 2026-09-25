// Unit tests for the agentpod-errors OpenClaw plugin. Node's own runner, no
// dependencies:  node --test test/*.test.js
//
// Every event below is shaped exactly as OpenClaw 2026.7.1-2 delivered it to a
// probe plugin on 2026-09-25, driven over ACP (`openclaw acp --session
// agent:krishna:main`) against a fake provider returning Kimi's real 403 and
// opencode-go's real 400. agent_end fired once per fallback attempt, with
// `success: true` both times; the failure is only in the last assistant
// message's stopReason and errorMessage.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import plugin, { attemptFrom, readableError, reportFor, socketPath, createReporter } from "../index.js";

const KIMI_403 =
  '{"type":"error","error":{"type":"permission_error","message":"You\'ve reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends."}}';
const OPENCODE_400 = "400 Request is missing x-opencode-session and cannot be routed efficiently.";

const ctx = { sessionKey: "agent:krishna:main", agentId: "krishna", runId: "run-1", channel: "webchat" };

function failedAttempt(provider, model, errorMessage) {
  return {
    messages: [
      { role: "user", content: [{ type: "text", text: "Are you here?" }] },
      { role: "assistant", stopReason: "error", errorMessage, provider, model, content: [] },
    ],
    success: true, // sic: OpenClaw says success for a failed attempt
    durationMs: 332,
    runId: "run-1",
  };
}

const answered = {
  messages: [
    { role: "user", content: [{ type: "text", text: "Are you here?" }] },
    { role: "assistant", stopReason: "stop", provider: "fakeb", model: "ok", content: [{ type: "text", text: "Yes." }] },
  ],
  success: true,
  runId: "run-1",
};

test("readableError finds the sentence inside a provider's JSON body", () => {
  assert.equal(
    readableError(KIMI_403),
    "You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends."
  );
  assert.equal(readableError(OPENCODE_400), OPENCODE_400);
  assert.equal(readableError('{"message":"top-level message"}'), "top-level message");
  assert.equal(readableError(""), undefined);
});

test("attemptFrom reads a failed attempt from agent_end", () => {
  assert.deepEqual(attemptFrom(failedAttempt("kimi-coding", "k2p6", KIMI_403)), {
    provider: "kimi-coding",
    model: "k2p6",
    message: "You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.",
  });
});

test("attemptFrom ignores an attempt that answered, whatever success says", () => {
  assert.equal(attemptFrom(answered), null);
  assert.equal(attemptFrom({ messages: [], success: true }), null);
  assert.equal(attemptFrom({}), null);
});

test("attemptFrom takes a failed run's own error when there is no assistant message", () => {
  // The hook's documented shape: success false with an error string.
  assert.deepEqual(attemptFrom({ success: false, error: "boom", messages: [] }, { modelProviderId: "p", modelId: "m" }), {
    provider: "p",
    model: "m",
    message: "boom",
  });
});

test("reportFor leads with the first attempt, the one that was asked for, and lists them all", () => {
  const attempts = [
    { provider: "kimi-coding", model: "k2p6", message: "quota" },
    { provider: "opencode-go", model: "hy3-preview", message: OPENCODE_400 },
  ];
  assert.deepEqual(reportFor("agent:krishna:main", attempts), {
    harnessSessionKey: "agent:krishna:main",
    error: { message: "quota", provider: "kimi-coding", model: "k2p6", attempts },
  });
});

test("socketPath matches the node's: home-derived, env overrides", () => {
  assert.equal(socketPath({}, "/home/openclaw"), "/home/openclaw/.agentpod/turn-errors.sock");
  assert.equal(socketPath({ AGENTPOD_TURN_ERROR_SOCKET: " /run/x.sock " }, "/h"), "/run/x.sock");
});

/** A fake node intake: records each line and answers as the node does. */
function fakeIntake(t, answer = "ok") {
  const dir = fs.mkdtempSync(path.join(os.platform() === "darwin" ? "/tmp" : os.tmpdir(), "oc-"));
  const sock = path.join(dir, "turn-errors.sock");
  const lines = [];
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) {
        lines.push(JSON.parse(buf.trim()));
        c.end(answer + "\n");
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

test("one report per failed run, after the run goes quiet, with every attempt", async (t) => {
  const { sock, lines } = fakeIntake(t);
  const reporter = createReporter({ socket: sock, quietMs: 50 });

  reporter.onAgentEnd(failedAttempt("kimi-coding", "k2p6", KIMI_403), ctx);
  await sleep(20);
  reporter.onAgentEnd(failedAttempt("opencode-go", "hy3-preview", OPENCODE_400), ctx);
  await sleep(200);

  assert.equal(lines.length, 1);
  assert.equal(lines[0].harnessSessionKey, "agent:krishna:main");
  assert.match(lines[0].error.message, /weekly \(7-day\) usage limit/);
  assert.deepEqual(
    lines[0].error.attempts.map((a) => a.provider),
    ["kimi-coding", "opencode-go"]
  );
});

test("a run whose fallback answered is not reported", async (t) => {
  const { sock, lines } = fakeIntake(t);
  const reporter = createReporter({ socket: sock, quietMs: 50 });

  reporter.onAgentEnd(failedAttempt("kimi-coding", "k2p6", KIMI_403), ctx);
  await sleep(10);
  reporter.onAgentEnd(answered, ctx);
  await sleep(200);

  assert.equal(lines.length, 0);
});

test("a run with no session key has nothing to be matched to, and is not sent", async (t) => {
  const { sock, lines } = fakeIntake(t);
  const reporter = createReporter({ socket: sock, quietMs: 20 });
  reporter.onAgentEnd(failedAttempt("kimi-coding", "k2p6", KIMI_403), { runId: "r" });
  await sleep(120);
  assert.equal(lines.length, 0);
});

test("no node listening costs the harness nothing: no throw, one warning", async () => {
  const warnings = [];
  const reporter = createReporter({
    socket: "/tmp/definitely-not-a-socket-agentpod.sock",
    quietMs: 10,
    logger: { warn: (m) => warnings.push(m) },
  });
  reporter.onAgentEnd(failedAttempt("kimi-coding", "k2p6", KIMI_403), ctx);
  await sleep(150);
  reporter.onAgentEnd(failedAttempt("kimi-coding", "k2p6", KIMI_403), { ...ctx, runId: "run-2" });
  await sleep(150);
  assert.equal(warnings.length, 1);
});

test("the node's refusal is logged, not thrown", async (t) => {
  const { sock } = fakeIntake(t, "error: a report needs error.message");
  const warnings = [];
  const reporter = createReporter({ socket: sock, quietMs: 10, logger: { warn: (m) => warnings.push(m) } });
  reporter.onAgentEnd(failedAttempt("kimi-coding", "k2p6", KIMI_403), ctx);
  await sleep(150);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /refused/);
});

test("the entry registers agent_end and nothing that could change a turn", () => {
  const registered = [];
  plugin.register({ on: (name) => registered.push(name), logger: { warn() {}, info() {} } });
  assert.deepEqual(registered, ["agent_end"]);
});
