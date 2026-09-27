// agentpod-errors — tells AgentPod why a Pi turn failed.
//
// pi-acp forwards Pi's text, thinking and tool deltas over ACP and nothing
// else: when a model call fails, the assistant message's stopReason "error"
// and errorMessage never leave Pi, and the prompt resolves `end_turn`. An
// AgentPod room could only say "The agent completed without a reply".
//
// Pi shows every extension the failure. This one collects a turn's failed
// attempts (one message_end per attempt, Pi's own retries included) and, when
// Pi says the run has settled, writes one report to the AgentPod node on this
// machine, keyed by the hub session the node gave the adapter
// (AGENTPOD_ACP_SESSION — pi-acp passes its environment to Pi).
//
// It observes only. A Pi started by hand has no hub session and reports
// nothing; a node that is not listening costs Pi one warning.
//
// Written as erasable TypeScript with no imports beyond Node, so Pi's loader
// (jiti) and Node's type stripping both run it as it is.
// Spec: agentpod docs/superpowers/specs/2026-09-25-harness-error-standard-design.md.

import net from "node:net";
import os from "node:os";
import path from "node:path";

/** The contract's bound on attempts in one report (TurnErrorReport). */
export const MAX_ATTEMPTS = 16;

const SEND_TIMEOUT_MS = 2_000;

/** The node's intake socket. Must agree with node-agent internal/turnerror. */
export function socketPath(env = process.env, home = os.homedir()) {
  const override = (env.AGENTPOD_TURN_ERROR_SOCKET ?? "").trim();
  return override !== "" ? override : path.join(home, ".agentpod", "turn-errors.sock");
}

/** A leading HTTP status: Pi gives "403 {…}". */
const LEADING_STATUS = /^([1-5]\d\d)(?::\s*|\s+)/;

function parseBody(text) {
  if (typeof text !== "string") return undefined;
  const t = text.trim().replace(LEADING_STATUS, "");
  if (!t.startsWith("{")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** One failed model attempt from a message_end event, or null. */
export function attemptFrom(event) {
  const m = event?.message;
  if (!m || m.role !== "assistant" || m.stopReason !== "error") return null;
  const raw = typeof m.errorMessage === "string" ? m.errorMessage.trim() : "";
  const body = parseBody(raw);
  const inner = body?.error?.message ?? body?.message;
  const message = typeof inner === "string" && inner.trim() !== "" ? inner.trim() : raw || "The model call failed without a message.";
  const type = body?.error?.type ?? (body?.type !== "error" ? body?.type : undefined);
  const status = raw.match(LEADING_STATUS);
  return {
    provider: String(m.provider ?? "unknown"),
    model: String(m.model ?? "unknown"),
    message,
    ...(typeof type === "string" && type !== "" ? { providerErrorType: type } : {}),
    ...(status ? { httpStatus: Number.parseInt(status[1], 10) } : {}),
  };
}

function isAnswer(event) {
  const m = event?.message;
  return m?.role === "assistant" && m.stopReason !== "error";
}

/** Keep the first attempt — the model that was asked for — and the latest. */
function bounded(attempts) {
  if (attempts.length <= MAX_ATTEMPTS) return attempts;
  return [attempts[0], ...attempts.slice(attempts.length - (MAX_ATTEMPTS - 1))];
}

function send(socket, report) {
  return new Promise((resolve) => {
    let reply = "";
    let settled = false;
    const conn = net.createConnection(socket);
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      conn.destroy();
      resolve(outcome);
    };
    conn.setTimeout(SEND_TIMEOUT_MS, () => done({ ok: false, why: "the node did not answer" }));
    conn.on("connect", () => conn.write(JSON.stringify(report) + "\n"));
    conn.on("data", (d) => {
      reply += d;
      if (reply.includes("\n")) {
        const line = reply.split("\n")[0].trim();
        done(line === "ok" ? { ok: true } : { ok: false, why: `the node refused it: ${line}` });
      }
    });
    conn.on("error", (err) =>
      done({ ok: false, why: err.code === "ENOENT" || err.code === "ECONNREFUSED" ? "no AgentPod node is listening" : err.message })
    );
    conn.on("end", () => done({ ok: false, why: "the node closed without answering" }));
  });
}

/** Collects a turn's failed attempts and reports them when Pi settles. */
export function createReporter({ socket = socketPath(), session = process.env.AGENTPOD_ACP_SESSION, logger = console } = {}) {
  let attempts = [];
  let warnedNoNode = false;

  return {
    onMessageEnd(event) {
      const attempt = attemptFrom(event);
      if (attempt) attempts.push(attempt);
      else if (isAnswer(event)) attempts = []; // a retry answered: the turn did not fail
    },

    async onSettled() {
      const failed = bounded(attempts);
      attempts = [];
      if (failed.length === 0 || !session) return;
      const [first] = failed;
      const report = {
        acpSessionId: session,
        error: {
          message: first.message,
          provider: first.provider,
          model: first.model,
          ...(first.providerErrorType ? { providerErrorType: first.providerErrorType } : {}),
          ...(first.httpStatus ? { httpStatus: first.httpStatus } : {}),
          attempts: failed,
        },
      };
      const outcome = await send(socket, report);
      if (outcome.ok) return;
      if (outcome.why === "no AgentPod node is listening") {
        if (warnedNoNode) return;
        warnedNoNode = true;
      }
      logger.warn?.(`agentpod-errors: a failed turn was not reported (${outcome.why})`);
    },
  };
}

export default function agentpodErrors(pi) {
  const reporter = createReporter();
  pi.on("message_end", async (event) => {
    try {
      reporter.onMessageEnd(event);
    } catch {
      // Observing must never break a turn.
    }
  });
  pi.on("agent_settled", async () => {
    try {
      await reporter.onSettled();
    } catch {
      // Observing must never break a turn.
    }
  });
}
