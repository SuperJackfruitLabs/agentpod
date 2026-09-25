import { describe, expect, test } from "bun:test";
import { TurnError } from "@agentpod/contract";
import {
  classifyText,
  turnErrorFromReason,
  turnErrorFromRejection,
  turnErrorForSilentTurn,
  turnErrorFromPlugin,
} from "./turn-error";

/**
 * Every message below is one a harness or provider really produced, with where
 * it was seen. A row with no source is a guess, and a guessed kind shown to a
 * reader is worse than `unknown` with the real text.
 */
describe("classifyText — the words a failure arrives in", () => {
  const rows: Array<[string, string, string]> = [
    // OpenClaw log on ashram, 2026-09-25 05:47:57 (Kimi, HTTP 403).
    [
      "⚠️ You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.",
      "quota",
      "kimi-coding weekly quota",
    ],
    // OpenClaw log on ashram, 2026-09-25 05:47:59 (opencode-go, HTTP 400).
    [
      "400 Request is missing x-opencode-session and cannot be routed efficiently.",
      "bad_request",
      "opencode-go missing session header",
    ],
    // OpenClaw log on ashram, 2026-09-25 05:48:59 (buddhimaan).
    [
      "Couldn't sign in to kimi-coding. Your saved login looks expired or no longer works. (No API key found for provider \"kimi-coding\".)",
      "auth",
      "missing kimi key",
    ],
    // OpenClaw log on ashram, 2026-09-24 (surya).
    ["FailoverError: LLM request timed out.", "timeout", "provider timeout"],
    // claude-agent-acp 0.66.0: the CLI's result text on a 429.
    ["API Error: 429 rate_limit_error: Number of requests has exceeded your rate limit", "rate_limit", "Claude 429"],
    // ACP SDK RequestError.authRequired(), as Claude Code and OpenCode send it.
    ["Authentication required", "auth", "ACP authRequired"],
    // The hub's own words (acp-sessions.ts handleWireClosed).
    ["Couldn't reach the node.", "node_offline", "hub: node gone"],
    ["node offline", "node_offline", "hub: node offline state"],
    // node-agent internal/acp/session.go OnExit: a Go exec error string.
    ["exit status 1", "harness_exited", "adapter exited non-zero"],
    ["signal: killed", "harness_exited", "adapter killed"],
  ];

  for (const [text, kind, why] of rows) {
    test(`${why} → ${kind}`, () => {
      expect(classifyText(text)).toBe(kind as never);
    });
  }

  // PR #565 review: ordinary text that merely contains a number or the letters
  // "log in" must not become a confident kind. `auth` is not retryable, so a
  // wrong `auth` would hide "try again" from someone who only needed it.
  const notErrors: Array<[string, string]> = [
    ["Model kimi-k3 not found in the model catalog in this provider", "'catalog in' is not 'log in'"],
    ["Error: could not read file /var/log in workspace", "a path is not a login"],
    ["tool output truncated after 500 lines", "a count is not a status code"],
    ["retried 3 times over 401 ms", "a duration is not a status code"],
  ];
  for (const [text, why] of notErrors) {
    test(`${why} → unknown`, () => {
      expect(classifyText(text)).toBe("unknown");
    });
  }

  test("a status code still counts where it reads as one", () => {
    expect(classifyText("HTTP 503 Service Unavailable")).toBe("provider_unavailable");
    expect(classifyText("upstream returned status 401")).toBe("auth");
    expect(classifyText("Error code: 429")).toBe("rate_limit");
    // claude-agent-acp: "Please run /login" is its not-signed-in result.
    expect(classifyText("Invalid API key · Please run /login")).toBe("auth");
  });

  test("text that matches nothing is unknown, not a guess", () => {
    expect(classifyText("Something odd happened in the flux capacitor")).toBe("unknown");
  });

  test("quota wins over rate limit: Kimi's quota message also says 'limit'", () => {
    expect(classifyText("You've reached your weekly (7-day) usage limit")).toBe("quota");
  });
});

/** An ACP SDK RequestError, as the hub's `session/prompt` rejection sees it. */
function rejection(message: string, data?: unknown, code = -32603) {
  return Object.assign(new Error(message), { code, data });
}

describe("turnErrorFromRejection — a harness that failed the prompt", () => {
  test("Codex quota: the words are in data, not in message", () => {
    // codex-acp 1.12.0 rejects with internalError(createTurnErrorData(...)):
    // message "Internal error", the provider's text in data.message.
    const err = turnErrorFromRejection(
      rejection("Internal error", {
        message: "You've hit your usage limit. Upgrade to Pro or try again later.",
        codexErrorInfo: "usageLimitExceeded",
      }),
      "codex"
    );

    expect(err.message).toBe("You've hit your usage limit. Upgrade to Pro or try again later.");
    expect(err.kind).toBe("quota");
    expect(err.retryable).toBe(false);
    expect(err.source).toBe("acp-rejection");
    expect(TurnError.parse(err)).toEqual(err);
  });

  test("Codex structured error info names its category by its key", () => {
    const err = turnErrorFromRejection(
      rejection("Internal error", {
        message: "stream disconnected before completion",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
      }),
      "codex"
    );
    expect(err.kind).toBe("provider_unavailable");
    expect(err.retryable).toBe(true);
  });

  test("Codex additionalDetails is kept when it says more than message", () => {
    const err = turnErrorFromRejection(
      rejection("Internal error", { message: "unexpected status 401", additionalDetails: "Your access token could not be refreshed." }),
      "codex"
    );
    expect(err.message).toContain("unexpected status 401");
    expect(err.message).toContain("Your access token could not be refreshed.");
  });

  test("Claude Code: errorKind is typed, and 'Internal error: ' is not the reader's business", () => {
    // claude-agent-acp: RequestError.internalError({ errorKind }, result),
    // whose message the SDK renders as "Internal error: <result>".
    const err = turnErrorFromRejection(
      rejection("Internal error: API Error: 529 overloaded_error: Overloaded", { errorKind: "overloaded" }),
      "claude-code"
    );
    expect(err.kind).toBe("provider_unavailable");
    expect(err.message).toBe("API Error: 529 overloaded_error: Overloaded");
  });

  test("Claude Code billing is quota, whatever the text says", () => {
    const err = turnErrorFromRejection(
      rejection("Internal error: Credit balance is too low", { errorKind: "billing_error" }),
      "claude-code"
    );
    expect(err.kind).toBe("quota");
  });

  test("OpenCode auth: the provider is only in data, and is kept", () => {
    // opencode 1.18.30 acp/error.ts: authRequired with { providerID } in data.
    const err = turnErrorFromRejection(
      rejection("Authentication required: provider authentication required", { providerID: "anthropic" }, -32000),
      "opencode"
    );
    expect(err.kind).toBe("auth");
    expect(err.provider).toBe("anthropic");
  });

  test("ACP's auth code decides only when the words do not", () => {
    // -32000 is ACP auth_required, but adapters reuse it: the hub's own fake
    // node rejects "Provider quota exhausted" with it. Words that say what
    // happened beat a code that only might.
    expect(turnErrorFromRejection(rejection("Provider quota exhausted", undefined, -32000), "x").kind).toBe("quota");
    expect(turnErrorFromRejection(rejection("Please sign up first", undefined, -32000), "x").kind).toBe("auth");
  });

  test("a plain Error with nothing but a message still becomes a TurnError", () => {
    const err = turnErrorFromRejection(new Error("exit status 1"), "pi");
    expect(err).toMatchObject({ kind: "harness_exited", harness: "pi", message: "exit status 1" });
  });

  test("something thrown that is not an Error keeps its text", () => {
    const err = turnErrorFromRejection("boom", "pi");
    expect(err.message).toBe("boom");
    expect(err.kind).toBe("unknown");
  });
});

describe("turnErrorForSilentTurn — a prompt that resolved with nothing", () => {
  test("end_turn with nothing is what OpenClaw and Pi send for a provider failure", () => {
    const err = turnErrorForSilentTurn("openclaw", "end_turn");
    expect(err.message).toBe("The agent completed without a reply.");
    expect(err.kind).toBe("unknown");
    expect(err.source).toBe("acp-stop-reason");
  });

  test("a refusal says so", () => {
    expect(turnErrorForSilentTurn("claude-code", "refusal").kind).toBe("refusal");
  });

  test("a turn the harness cancelled itself says so", () => {
    expect(turnErrorForSilentTurn("codex", "cancelled").kind).toBe("cancelled");
  });

  test("an output limit hit before any reply says so", () => {
    expect(turnErrorForSilentTurn("claude-code", "max_tokens").kind).toBe("max_tokens");
  });
});

describe("turnErrorFromReason — the hub's own failures", () => {
  test("a node that went away", () => {
    const err = turnErrorFromReason("Couldn't reach the node.", "openclaw", "session-state");
    expect(err).toMatchObject({ kind: "node_offline", retryable: true, source: "session-state" });
  });
});

describe("turnErrorFromPlugin — what a harness plugin reported", () => {
  test("keeps what the plugin knew, and the hub names harness and source", () => {
    const err = turnErrorFromPlugin(
      {
        message: "⚠️ You've reached your weekly (7-day) usage limit.",
        kind: "quota",
        provider: "kimi-coding",
        model: "k2p6",
        attempts: [{ provider: "kimi-coding", model: "k2p6", kind: "quota", message: "403" }],
      },
      "openclaw"
    );
    expect(err).toEqual({
      message: "⚠️ You've reached your weekly (7-day) usage limit.",
      kind: "quota",
      provider: "kimi-coding",
      model: "k2p6",
      attempts: [{ provider: "kimi-coding", model: "k2p6", kind: "quota", message: "403" }],
      harness: "openclaw",
      source: "plugin",
      retryable: false,
    });
  });

  test("classifies the words when the plugin gave no kind", () => {
    const err = turnErrorFromPlugin({ message: "FailoverError: LLM request timed out." }, "openclaw");
    expect(err).toMatchObject({ kind: "timeout", retryable: true, source: "plugin" });
  });

  test("classifies each attempt the plugin listed without a kind", () => {
    const err = turnErrorFromPlugin(
      {
        message: "You've reached your weekly (7-day) usage limit.",
        attempts: [
          { provider: "kimi-coding", model: "k2p6", message: "You've reached your weekly (7-day) usage limit." },
          { provider: "opencode-go", model: "hy3-preview", message: "400 Request is missing x-opencode-session" },
        ],
      },
      "openclaw"
    );
    expect(err.kind).toBe("quota");
    expect(err.attempts!.map((a) => a.kind)).toEqual(["quota", "bad_request"]);
  });

  test("a plugin's own retryable wins over the kind's default", () => {
    const err = turnErrorFromPlugin({ message: "quota", kind: "quota", retryable: true }, "pi");
    expect(err.retryable).toBe(true);
  });
});
