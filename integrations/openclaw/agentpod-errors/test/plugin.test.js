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

import plugin, { QUIET_MS, attemptFrom, readableError, reportFor, socketPath, createReporter } from "../index.js";

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

test("attemptFrom reads a failed attempt from agent_end, with the provider's error type", () => {
  assert.deepEqual(attemptFrom(failedAttempt("kimi-coding", "k2p6", KIMI_403)), {
    provider: "kimi-coding",
    model: "k2p6",
    message: "You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.",
    providerErrorType: "permission_error",
  });
});

test("the provider's own error type travels beside the words, not inside them", () => {
  // opencode-go on ashram, 2026-09-26 05:05, over anthropic-messages: the body
  // names the failure MissingSessionID; the sentence alone does not say 400.
  const body = '{"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently."}}';
  const a = attemptFrom(failedAttempt("opencode-go", "qwen3.7-plus", body));
  assert.equal(a.message, "Request is missing x-opencode-session and cannot be routed efficiently.");
  assert.equal(a.providerErrorType, "MissingSessionID");
  // Plain text has no type to report.
  assert.equal("providerErrorType" in attemptFrom(failedAttempt("x", "y", OPENCODE_400)), false);
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
    { provider: "kimi-coding", model: "k2p6", message: "quota", providerErrorType: "permission_error" },
    { provider: "opencode-go", model: "hy3-preview", message: OPENCODE_400 },
  ];
  assert.deepEqual(reportFor("agent:krishna:main", attempts), {
    harnessSessionKey: "agent:krishna:main",
    error: { message: "quota", provider: "kimi-coding", model: "k2p6", providerErrorType: "permission_error", attempts },
  });
});

// OpenClaw 2026.9.6 (npm latest, 2026-09-26) shapes the same failures
// differently from the fleet's 2026.7.1-2: a status in front of the JSON, and
// separate errorBody / errorCode / errorType fields. Recorded from a real
// 2026.9.6 driven over ACP against the same fake provider.
function failed96(provider, model, fields) {
  return {
    messages: [
      { role: "user", content: [{ type: "text", text: "Are you here?" }] },
      { role: "assistant", stopReason: "error", provider, model, content: [], ...fields },
    ],
    success: true,
    runId: "run-1",
  };
}

test("OpenClaw 2026.9.6's '403: {json}' reads as the sentence, with its status", () => {
  const a = attemptFrom(
    failed96("kimi-coding", "k2p6", {
      errorMessage: '403: {"error":{"message":"You\'ve reached your weekly (7-day) usage limit."}}',
      errorBody: '{"error":{"message":"You\'ve reached your weekly (7-day) usage limit."}}',
      errorCode: "403",
    })
  );
  assert.equal(a.message, "You've reached your weekly (7-day) usage limit.");
  assert.equal(a.httpStatus, 403);
  assert.equal("providerErrorType" in a, false);
});

test("OpenClaw's own errorType is used, and the body gives the sentence without its status", () => {
  const a = attemptFrom(
    failed96("opencode-go", "qwen3.7-plus", {
      errorMessage: "400 Request is missing x-opencode-session and cannot be routed efficiently.",
      errorBody: '{"message":"Request is missing x-opencode-session and cannot be routed efficiently.","type":"MissingSessionID"}',
      errorCode: "400",
      errorType: "MissingSessionID",
    })
  );
  assert.equal(a.message, "Request is missing x-opencode-session and cannot be routed efficiently.");
  assert.equal(a.providerErrorType, "MissingSessionID");
  assert.equal(a.httpStatus, 400);
});

test("a leading status in plain text is read, and the text kept whole", () => {
  const a = attemptFrom(failedAttempt("opencode-go", "hy3-preview", OPENCODE_400));
  assert.equal(a.message, OPENCODE_400);
  assert.equal(a.httpStatus, 400);
});

test("the quiet window outlasts the gaps OpenClaw really leaves between attempts", () => {
  // krishna, ashram, 2026-09-26 05:05, run 26fed3f8: agent_end at 08.361,
  // 09.951, 11.143, 12.378, 13.194, 14.094 — a widest gap of 1.59 s. At 750 ms
  // the plugin sent after nearly every attempt, and the room got the last
  // model's error twice and never the first model's.
  const gaps = [1590, 1192, 1235, 816, 900];
  assert.ok(QUIET_MS >= Math.max(...gaps) * 1.5, `QUIET_MS ${QUIET_MS} is too close to a real 1.59 s gap`);
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

test("krishna's real run, replayed at a tenth of the speed, is one report of six attempts", async (t) => {
  const { sock, lines } = fakeIntake(t);
  const reporter = createReporter({ socket: sock, quietMs: QUIET_MS / 10 });
  const QWEN_400 = '{"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently."}}';
  const sequence = [
    [0, failedAttempt("kimi-coding", "k2p6", KIMI_403)],
    [159, failedAttempt("opencode-go", "hy3-preview", OPENCODE_400)],
    [119, failedAttempt("opencode-go", "qwen3.7-plus", QWEN_400)],
    [124, failedAttempt("opencode-go", "qwen3.7-plus", QWEN_400)],
    [82, failedAttempt("opencode-go", "qwen3.7-plus", QWEN_400)],
    [90, failedAttempt("opencode-go", "qwen3.7-plus", QWEN_400)],
  ];
  for (const [gap, event] of sequence) {
    await sleep(gap);
    reporter.onAgentEnd(event, ctx);
  }
  await sleep(QUIET_MS / 10 + 200);

  assert.equal(lines.length, 1, `sent ${lines.length} reports for one run`);
  assert.equal(lines[0].error.provider, "kimi-coding");
  assert.match(lines[0].error.message, /weekly \(7-day\) usage limit/);
  assert.equal(lines[0].error.attempts.length, 6);
});

test("never more attempts than the contract takes: the first and the latest are kept", async (t) => {
  // TurnErrorReport caps attempts at 16; a report over it is refused whole.
  const { sock, lines } = fakeIntake(t);
  const reporter = createReporter({ socket: sock, quietMs: 40 });
  reporter.onAgentEnd(failedAttempt("kimi-coding", "first", KIMI_403), ctx);
  for (let i = 0; i < 30; i++) reporter.onAgentEnd(failedAttempt("opencode-go", `m${i}`, OPENCODE_400), ctx);
  await sleep(200);
  const attempts = lines[0].error.attempts;
  assert.equal(attempts.length, 16);
  assert.equal(attempts[0].model, "first");
  assert.equal(attempts.at(-1).model, "m29");
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
