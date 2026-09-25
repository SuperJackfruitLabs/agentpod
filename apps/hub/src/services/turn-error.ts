/**
 * One error shape, whichever harness failed.
 *
 * The six harnesses fail six ways over ACP. Claude Code and OpenCode reject
 * `session/prompt` with the provider's words in `message`; Codex rejects with
 * "Internal error" and puts the words in `data`; OpenClaw and Pi resolve
 * `end_turn` having said nothing at all. This module reduces what does arrive
 * to a `TurnError`, so a room and the console show a failure the same way
 * whoever caused it.
 *
 * Typed fields win over text. Where there are none, the text is matched against
 * phrases real failures used — each row in `turn-error.test.ts` cites where it
 * was seen. A phrase nobody has seen is not added: `unknown` with the real
 * message is honest, and a confident wrong kind is not.
 *
 * Spec: docs/superpowers/specs/2026-09-25-harness-error-standard-design.md.
 */
import type { TurnError, TurnErrorKind, TurnErrorSource } from "@agentpod/contract";

/** Order matters: the first match wins. */
const TEXT_RULES: Array<[RegExp, TurnErrorKind]> = [
  // Before rate_limit: Kimi's quota message says "usage limit".
  [/usage limit|quota|billing|credit balance|insufficient (credit|balance|funds)/i, "quota"],
  [/rate.?limit|too many requests|\b429\b/i, "rate_limit"],
  // Before bad_request: an auth failure can carry a 400 in some providers.
  [/authenticat|unauthori[sz]ed|\b401\b|api key|sign in|log ?in\b|\/login/i, "auth"],
  [/context (window|length)|maximum context|too many tokens/i, "context_exhausted"],
  [/timed? ?out\b/i, "timeout"],
  [/overloaded|service unavailable|\b50[0234]\b/i, "provider_unavailable"],
  [/\b400\b|bad request|invalid request/i, "bad_request"],
  [/couldn't reach the node|node (is )?offline/i, "node_offline"],
  [/^exit$|exit status \d+|^signal: \w+/i, "harness_exited"],
];

export function classifyText(text: string): TurnErrorKind {
  for (const [pattern, kind] of TEXT_RULES) {
    if (pattern.test(text)) return kind;
  }
  return "unknown";
}

/** claude-agent-sdk `SDKAssistantMessageError`, sent as `data.errorKind`. */
const CLAUDE_ERROR_KINDS: Record<string, TurnErrorKind> = {
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  billing_error: "quota",
  rate_limit: "rate_limit",
  overloaded: "provider_unavailable",
  server_error: "provider_unavailable",
  invalid_request: "bad_request",
  model_not_found: "bad_request",
  max_output_tokens: "max_tokens",
};

/**
 * codex-acp `codexErrorInfo`: a string, or an object keyed by one category.
 * Mirrors codex-acp's own STRING_/STRUCTURED_CODEX_ERROR_CATEGORIES.
 */
const CODEX_ERROR_KINDS: Record<string, TurnErrorKind> = {
  contextWindowExceeded: "context_exhausted",
  sessionBudgetExceeded: "quota",
  usageLimitExceeded: "quota",
  rateLimitExceeded: "rate_limit",
  serverOverloaded: "provider_unavailable",
  internalServerError: "provider_unavailable",
  unauthorized: "auth",
  badRequest: "bad_request",
  cyberPolicy: "refusal",
  misalignmentPolicyViolation: "refusal",
  httpConnectionFailed: "provider_unavailable",
  responseStreamConnectionFailed: "provider_unavailable",
  responseStreamDisconnected: "provider_unavailable",
  responseTooManyFailedAttempts: "provider_unavailable",
};

/** ACP's `auth_required` JSON-RPC code. */
const ACP_AUTH_REQUIRED = -32000;

const RETRYABLE: Partial<Record<TurnErrorKind, boolean>> = {
  rate_limit: true,
  timeout: true,
  provider_unavailable: true,
  node_offline: true,
  quota: false,
  auth: false,
  bad_request: false,
  context_exhausted: false,
  refusal: false,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function build(
  message: string,
  kind: TurnErrorKind,
  harness: string,
  source: TurnErrorSource,
  extra: Partial<TurnError> = {}
): TurnError {
  const retryable = RETRYABLE[kind];
  return {
    message,
    kind,
    harness,
    source,
    ...(retryable === undefined ? {} : { retryable }),
    ...extra,
  };
}

function typedKind(data: Record<string, unknown>): TurnErrorKind | undefined {
  const claude = nonEmpty(data.errorKind);
  if (claude && CLAUDE_ERROR_KINDS[claude]) return CLAUDE_ERROR_KINDS[claude];

  const codex = data.codexErrorInfo;
  const codexKey = typeof codex === "string" ? codex : isRecord(codex) ? Object.keys(codex)[0] : undefined;
  if (codexKey && CODEX_ERROR_KINDS[codexKey]) return CODEX_ERROR_KINDS[codexKey];

  return undefined;
}

/**
 * What the reader should see. The SDK prefixes its generic code name
 * ("Internal error: …"), which says nothing to someone whose quota ran out; the
 * detail in `data` is often the only real sentence there is.
 */
function readableMessage(raw: string, data: Record<string, unknown>): string {
  const own = raw.replace(/^Internal error:\s*/i, "").trim();
  const generic = own === "" || /^internal error$/i.test(own);
  const parts = [generic ? undefined : own, nonEmpty(data.message), nonEmpty(data.additionalDetails)];

  const seen: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (seen.some((s) => s.includes(part))) continue;
    seen.push(part);
  }
  return seen.length > 0 ? seen.join(" — ") : raw;
}

/** A harness that failed the prompt: the `session/prompt` rejection. */
export function turnErrorFromRejection(err: unknown, harness: string): TurnError {
  const raw = err instanceof Error ? err.message : String(err);
  const record = isRecord(err) ? err : {};
  const data = isRecord(record.data) ? record.data : {};

  const message = readableMessage(raw, data);
  const fromText = classifyText(message);
  const kind =
    typedKind(data) ??
    (fromText !== "unknown" ? fromText : record.code === ACP_AUTH_REQUIRED ? "auth" : "unknown");

  // OpenCode names the provider only in `data` on an auth failure.
  const provider = nonEmpty(data.providerID) ?? nonEmpty(data.provider);
  return build(message, kind, harness, "acp-rejection", provider ? { provider } : {});
}

const SILENT: Record<string, { message: string; kind: TurnErrorKind }> = {
  refusal: { message: "The agent declined to answer.", kind: "refusal" },
  max_tokens: { message: "The agent reached its output limit before replying.", kind: "max_tokens" },
};

/**
 * A prompt that resolved having produced nothing. For OpenClaw and Pi this is
 * what a provider failure looks like over ACP — the words are only in the
 * harness's own log until a plugin reports them.
 */
export function turnErrorForSilentTurn(harness: string, stopReason: unknown): TurnError {
  const known = typeof stopReason === "string" ? SILENT[stopReason] : undefined;
  if (known) return build(known.message, known.kind, harness, "acp-stop-reason");
  return build("The agent completed without a reply.", "unknown", harness, "acp-stop-reason");
}

/** A failure the hub itself names: a node gone, an adapter exited, a failed write. */
export function turnErrorFromReason(reason: string, harness: string, source: TurnErrorSource): TurnError {
  return build(reason, classifyText(reason), harness, source);
}
