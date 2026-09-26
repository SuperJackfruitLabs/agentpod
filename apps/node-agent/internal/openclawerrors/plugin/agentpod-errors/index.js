// agentpod-errors — tells AgentPod why an OpenClaw turn failed.
//
// OpenClaw's ACP bridge resolves a failed turn as `end_turn` and drops the
// provider's words (`handleChatEvent`, state "error"), so an AgentPod room
// could only say "The agent completed without a reply". OpenClaw does show the
// failure to plugins: `agent_end` fires once per model attempt, and a failed
// attempt's last assistant message carries `stopReason: "error"` and the
// provider's `errorMessage` — while `success` still says true. This plugin
// collects a run's failed attempts and, once the run goes quiet, writes one
// report to the AgentPod node on this machine, which forwards it to the hub.
//
// It observes only. It registers no hook that can change a turn, and a node
// that is not listening costs the harness nothing but one warning.
//
// Plain ESM with no dependencies, so it loads from a directory without a build.
// Spec: agentpod docs/superpowers/specs/2026-09-25-harness-error-standard-design.md.

import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * How long a run must be quiet before its failure is reported. OpenClaw fires
 * agent_end for every fallback attempt and every retry; waiting lets one report
 * carry the whole chain.
 *
 * 750 ms was measured against a fake provider that failed instantly. On ashram
 * (2026-09-26, krishna, run 26fed3f8) real attempts landed 0.8–1.6 s apart, so
 * 750 ms sent a report after nearly every one: the room got the last model's
 * error twice and never the first's. 2.5 s clears the widest real gap with room
 * to spare; the hub waits 5 s after the prompt resolves.
 */
export const QUIET_MS = 2_500;

/** Bound on one socket exchange, so a wedged node cannot hold a report open. */
const SEND_TIMEOUT_MS = 2_000;

/** The node's intake socket. Must agree with node-agent internal/turnerror. */
export function socketPath(env = process.env, home = os.homedir()) {
  const override = (env.AGENTPOD_TURN_ERROR_SOCKET ?? "").trim();
  return override !== "" ? override : path.join(home, ".agentpod", "turn-errors.sock");
}

/**
 * The sentence a person should read. Anthropic-style providers put the raw
 * response body in errorMessage (Kimi: {"type":"error","error":{"message":…}});
 * OpenAI-style ones give the text itself.
 */
export function readableError(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const body = JSON.parse(text);
      const inner = body?.error?.message ?? body?.message;
      if (typeof inner === "string" && inner.trim() !== "") return inner.trim();
    } catch {
      // Not JSON after all; the text is the message.
    }
  }
  return text;
}

/**
 * The provider's own name for the failure, when its body has one: Anthropic's
 * `invalid_request_error`, opencode-go's `MissingSessionID`. The hub classifies
 * by it before it reads any words, so it travels beside the message.
 */
export function providerErrorType(raw) {
  if (typeof raw !== "string" || !raw.trim().startsWith("{")) return undefined;
  try {
    const body = JSON.parse(raw.trim());
    const type = body?.error?.type ?? (body?.type !== "error" ? body?.type : undefined);
    return typeof type === "string" && type.trim() !== "" ? type.trim() : undefined;
  } catch {
    return undefined;
  }
}

function lastAssistant(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

/**
 * One failed model attempt from an agent_end event, or null when the attempt
 * answered. `success` is not trusted: OpenClaw 2026.7.1-2 reports true for an
 * attempt whose provider returned 403.
 */
export function attemptFrom(event, ctx = {}) {
  const last = lastAssistant(event?.messages);
  if (last && last.stopReason === "error") {
    const message = readableError(last.errorMessage) ?? "The model call failed without a message.";
    const type = providerErrorType(last.errorMessage);
    return {
      provider: String(last.provider ?? ctx.modelProviderId ?? "unknown"),
      model: String(last.model ?? ctx.modelId ?? "unknown"),
      message,
      ...(type ? { providerErrorType: type } : {}),
    };
  }
  if (last) return null;
  // No assistant message at all: the hook's documented failure shape.
  if (event?.success === false) {
    return {
      provider: String(ctx.modelProviderId ?? "unknown"),
      model: String(ctx.modelId ?? "unknown"),
      message: readableError(event.error) ?? "The run failed without a message.",
    };
  }
  return null;
}

/**
 * The report for a failed run. It leads with the first attempt — the model the
 * agent was configured to use — because the fallbacks failing is a consequence;
 * the first failure is usually the cause (krishna: Kimi's quota).
 */
export function reportFor(sessionKey, attempts) {
  const [first] = attempts;
  return {
    harnessSessionKey: sessionKey,
    error: {
      message: first.message,
      provider: first.provider,
      model: first.model,
      ...(first.providerErrorType ? { providerErrorType: first.providerErrorType } : {}),
      attempts,
    },
  };
}

function send(socket, report) {
  return new Promise((resolve) => {
    let reply = "";
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      conn.destroy();
      resolve(outcome);
    };
    const conn = net.createConnection(socket);
    conn.setTimeout(SEND_TIMEOUT_MS, () => done({ ok: false, why: "the node did not answer" }));
    conn.on("connect", () => conn.write(JSON.stringify(report) + "\n"));
    conn.on("data", (d) => {
      reply += d;
      if (reply.includes("\n")) {
        const line = reply.split("\n")[0].trim();
        done(line === "ok" ? { ok: true } : { ok: false, why: `the node refused it: ${line}` });
      }
    });
    conn.on("error", (err) => done({ ok: false, why: err.code === "ENOENT" || err.code === "ECONNREFUSED" ? "no AgentPod node is listening" : err.message }));
    conn.on("end", () => done({ ok: false, why: "the node closed without answering" }));
  });
}

/** Collects failed attempts per run and reports each failed run once. */
export function createReporter({ socket = socketPath(), quietMs = QUIET_MS, logger = console } = {}) {
  const runs = new Map();
  let warnedNoNode = false;

  const flush = async (runId) => {
    const run = runs.get(runId);
    runs.delete(runId);
    if (!run || run.attempts.length === 0) return;
    const outcome = await send(socket, reportFor(run.sessionKey, run.attempts));
    if (outcome.ok) return;
    if (outcome.why === "no AgentPod node is listening") {
      // Said once: a machine without a node is a normal place to run OpenClaw.
      if (warnedNoNode) return;
      warnedNoNode = true;
    }
    logger.warn?.(`agentpod-errors: a failed turn was not reported (${outcome.why})`);
  };

  return {
    onAgentEnd(event, ctx = {}) {
      const runId = event?.runId ?? ctx.runId;
      const sessionKey = ctx.sessionKey;
      if (!runId || !sessionKey) return;

      const attempt = attemptFrom(event, ctx);
      const run = runs.get(runId);
      if (attempt === null) {
        // A fallback answered: the run did not fail, whatever came before.
        if (run) {
          clearTimeout(run.timer);
          runs.delete(runId);
        }
        return;
      }

      const next = run ?? { sessionKey, attempts: [], timer: null };
      clearTimeout(next.timer);
      next.attempts.push(attempt);
      next.timer = setTimeout(() => void flush(runId), quietMs);
      next.timer.unref?.();
      runs.set(runId, next);
    },
  };
}

export default {
  id: "agentpod-errors",
  name: "AgentPod errors",
  description: "Reports why a turn failed to the AgentPod node on this machine.",
  register(api) {
    const reporter = createReporter({ logger: api.logger ?? console });
    api.on("agent_end", async (event, ctx) => {
      try {
        reporter.onAgentEnd(event, ctx);
      } catch (err) {
        (api.logger ?? console).warn?.(`agentpod-errors: ${err?.message ?? err}`);
      }
    });
  },
};
