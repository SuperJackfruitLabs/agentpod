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
import { TurnErrorKind as TurnErrorKindSchema } from "@agentpod/contract";
import type { TurnError, TurnErrorCard, TurnErrorKind, TurnErrorReport, TurnErrorSource } from "@agentpod/contract";

/**
 * An HTTP status, only where it reads as one: leading the message ("400
 * Request is missing…", opencode-go) or after HTTP / status / code / API
 * Error. A bare number anywhere else is a count or a duration — "truncated
 * after 500 lines" is not a server error (PR #565 review).
 */
function status(codes: string): string {
  return String.raw`(?:^\s*|\b(?:https?\/?[\d.]*|status(?:\s+code)?|code|api error|error)\s*[:=]?\s*)(?:${codes})\b`;
}

/** Order matters: the first match wins. */
const TEXT_RULES: Array<[RegExp, TurnErrorKind]> = [
  // Before rate_limit: Kimi's quota message says "usage limit".
  [/usage limit|quota|billing|credit balance|insufficient (credit|balance|funds)/i, "quota"],
  [new RegExp(String.raw`rate.?limit|too many requests|${status("429")}`, "i"), "rate_limit"],
  // Before bad_request: an auth failure can carry a 400 in some providers.
  // "log in" only as words of its own: not "catalog in", not "/var/log in".
  // "/login" is claude-agent-acp's not-signed-in result ("Please run /login").
  [
    new RegExp(
      String.raw`authenticat|unauthori[sz]ed|api key|sign in|(?<![\w/.-])log ?in\b|\/login\b|${status("401")}`,
      "i"
    ),
    "auth",
  ],
  [/context (window|length)|maximum context|too many tokens/i, "context_exhausted"],
  [/timed? ?out\b/i, "timeout"],
  [
    new RegExp(
      String.raw`overloaded|service unavailable|internal server error|bad gateway|gateway timeout|${status("50[0234]")}`,
      "i"
    ),
    "provider_unavailable",
  ],
  [new RegExp(String.raw`bad request|invalid request|${status("400")}`, "i"), "bad_request"],
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

/**
 * A provider's own name for a failure, from its response body, as a plugin
 * reports it. Anthropic's standard error types, and those seen from providers
 * behind OpenClaw. `permission_error` is absent on purpose: Kimi sends it for a
 * used-up quota, so the words decide.
 */
const PROVIDER_ERROR_TYPES: Record<string, TurnErrorKind> = {
  invalid_request_error: "bad_request",
  not_found_error: "bad_request",
  request_too_large: "bad_request",
  authentication_error: "auth",
  rate_limit_error: "rate_limit",
  api_error: "provider_unavailable",
  overloaded_error: "provider_unavailable",
  // opencode-go over anthropic-messages, ashram 2026-09-26: HTTP 400 for a
  // request without its x-opencode-session header.
  MissingSessionID: "bad_request",
};

/**
 * The HTTP status, last: it only decides when the type and the words cannot.
 * 403 is absent on purpose — Kimi returns it for a used-up quota, and a 403
 * alone says "forbidden", not why.
 */
function kindOfStatus(status?: number): TurnErrorKind | undefined {
  if (status === undefined) return undefined;
  if (status === 401) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 404 || status === 413 || status === 422) return "bad_request";
  if (status >= 500) return "provider_unavailable";
  return undefined;
}

function kindOfReported(
  message: string,
  kind?: TurnErrorKind,
  providerErrorType?: string,
  httpStatus?: number
): TurnErrorKind {
  if (kind) return kind;
  const typed = providerErrorType ? PROVIDER_ERROR_TYPES[providerErrorType] : undefined;
  if (typed) return typed;
  const worded = classifyText(message);
  return worded !== "unknown" ? worded : kindOfStatus(httpStatus) ?? "unknown";
}

/** ACP's `auth_required` JSON-RPC code. */
const ACP_AUTH_REQUIRED = -32000;

const RETRYABLE: Partial<Record<TurnErrorKind, boolean>> = {
  rate_limit: true,
  timeout: true,
  provider_unavailable: true,
  node_offline: true,
  // The conversation is on disk and the next prompt works once the transport is
  // back, which is the whole reason this kind exists separately.
  harness_disconnected: true,
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

/**
 * Did this rejection tell us anything at all?
 *
 * True when the harness rejected `session/prompt` with the SDK's generic and nothing
 * else: no words of its own, no `data.message`, no typed kind. That is not a failure
 * this module can classify, and guessing a kind from an empty message is exactly the
 * "confident wrong kind" the header refuses.
 *
 * It exists so a CALLER can go and find out. Observed on ashram 2026-10-03: an OpenClaw
 * agent restarted the gateway it was running through, the bridge stayed up holding a
 * dead socket, and three prompts in a row came back as bare `"Internal error"`. Nothing
 * in the text could ever have revealed that; one question to the node does.
 *
 * Deliberately conservative — anything that carries a sentence or a typed kind said
 * SOMETHING, and asking the node about it would be a round trip to learn what we were
 * just told. The cost of a false positive is a pointless probe; the cost of a false
 * negative is the reader seeing "Internal error" again.
 */
export function rejectionSaidNothing(err: unknown): boolean {
  if (err === null || err === undefined) return true;
  const raw = err instanceof Error ? err.message : isRecord(err) ? String(err.message ?? "") : String(err);
  const record = isRecord(err) ? err : {};
  const data = isRecord(record.data) ? record.data : {};

  // Same stripping `readableMessage` does, so the two cannot disagree about what
  // "generic" means.
  const own = raw.replace(/^Internal error:\s*/i, "").trim();
  if (!(own === "" || /^internal error$/i.test(own))) return false;
  if (nonEmpty(data.message) || nonEmpty(data.additionalDetails)) return false;
  if (typedKind(data)) return false;
  return true;
}

/**
 * Did the node tell us, in so many words, that the harness's transport is down?
 *
 * Only `supported: true` **and** `reachable: false` counts. A harness with no notion of
 * a transport, a node too old to know the verb, an absent answer (`broker.request` never
 * rejects, so "offline" arrives as silence), or a shape that is not this one — all read
 * as *unknown*, and unknown must leave the harness's own error alone.
 *
 * The asymmetry is the point. A false positive tells somebody their gateway is down when
 * it is not, and sends them to fix the wrong thing; the bare "Internal error" it would
 * replace is unhelpful but not misleading, and that is the better failure to keep.
 */
export function gatewayUnreachable(probe: unknown): boolean {
  if (!isRecord(probe)) return false;
  return probe.supported === true && probe.reachable === false;
}

/**
 * What the room should have been told.
 *
 * Says the three things a person needs and "Internal error" gave none of: what broke,
 * that their conversation is intact, and what to do. The second matters most — the
 * transcript survives on disk (proven: 321 lines still being written after the crash),
 * but somebody shown a generic failure has no way to know that and will reasonably
 * assume an afternoon's context is gone.
 *
 * It does NOT offer to resend. The interrupted turn was running inside the thing that
 * went away and may have already had effects; re-sending it is the person's call, not
 * this hub's.
 */
export function turnErrorForUnreachableGateway(harness: string): TurnError {
  return build(
    `${harness}'s gateway stopped answering, so the turn was interrupted. The conversation is intact — send again to carry on.`,
    "harness_disconnected",
    harness,
    "hub"
  );
}

const SILENT: Record<string, { message: string; kind: TurnErrorKind }> = {
  refusal: { message: "The agent declined to answer.", kind: "refusal" },
  max_tokens: { message: "The agent reached its output limit before replying.", kind: "max_tokens" },
  // A user's cancel never reaches here (cancelTurn idles the session first), so
  // this is a harness that stopped its own turn.
  cancelled: { message: "The agent stopped the turn before replying.", kind: "cancelled" },
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

/**
 * What a harness plugin reported through its node (OpenClaw, Pi). The plugin
 * saw the failure; the hub names whose harness it was and where it came from,
 * because a report must not be able to claim another harness's identity.
 */
export function turnErrorFromPlugin(reported: NonNullable<TurnErrorReport["error"]>, harness: string): TurnError {
  const kind = kindOfReported(reported.message, reported.kind, reported.providerErrorType, reported.httpStatus);
  const { message, kind: _kind, retryable, attempts, ...rest } = reported;
  const classified = attempts?.map((a) => ({
    ...a,
    kind: kindOfReported(a.message, a.kind, a.providerErrorType, a.httpStatus),
  }));
  const error = build(message, kind, harness, "plugin", {
    ...rest,
    ...(classified ? { attempts: classified } : {}),
  });
  return retryable === undefined ? error : { ...error, retryable };
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

/**
 * The card a room's error notice carries (`dev.agentpod.turn_error`), from an
 * `error` event's payload — or null for a payload from before TurnError, which
 * has only words and is sent as words alone. Bounded to what the contract
 * allows, clipped rather than dropped: a long error is still a card.
 */
export function turnErrorCard(payload: unknown): TurnErrorCard | null {
  if (!isRecord(payload)) return null;
  const kind = TurnErrorKindSchema.safeParse(payload.kind);
  const message = nonEmpty(payload.message);
  const harness = nonEmpty(payload.harness);
  if (!kind.success || !message || !harness) return null;

  const attempts = Array.isArray(payload.attempts)
    ? payload.attempts
        .filter(isRecord)
        .map((a) => {
          const k = TurnErrorKindSchema.safeParse(a.kind);
          const m = nonEmpty(a.message);
          if (!k.success || !m) return null;
          return {
            provider: clip(nonEmpty(a.provider) ?? "unknown", 200),
            model: clip(nonEmpty(a.model) ?? "unknown", 200),
            kind: k.data,
            message: clip(m, 2000),
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .slice(0, 16)
    : undefined;

  const provider = nonEmpty(payload.provider);
  const model = nonEmpty(payload.model);
  return {
    schema_version: 1,
    kind: kind.data,
    message: clip(message, 4000),
    harness: clip(harness, 100),
    ...(provider ? { provider: clip(provider, 200) } : {}),
    ...(model ? { model: clip(model, 200) } : {}),
    ...(typeof payload.retryable === "boolean" ? { retryable: payload.retryable } : {}),
    ...(attempts && attempts.length > 0 ? { attempts } : {}),
  };
}
