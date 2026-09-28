/**
 * Apple Push Notification service, over HTTP/2, with token auth.
 *
 * No SDK: `node:http2` (which Bun implements) and `node:crypto` are the whole
 * dependency list. The two things an APNs client gets wrong are both here and
 * both tested — how often the provider token is re-signed, and which Apple
 * answers mean "this device is gone" rather than "try again".
 */

import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import http2 from "node:http2";

import type { ApnsEnvironment } from "./config";

// ─── The provider token ──────────────────────────────────────────────────────

/** Apple rejects a token older than an hour; this re-signs well inside it. */
export const TOKEN_REFRESH_MS = 50 * 60 * 1000;
/**
 * Apple answers `TooManyProviderTokenUpdates` to a provider that re-signs more
 * often than every 20 minutes — so this is a floor, even when a 403 asks for a
 * fresh one.
 */
export const TOKEN_MIN_INTERVAL_MS = 20 * 60 * 1000;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * The ES256 JWT APNs takes as `authorization: bearer …`.
 *
 * Cached: signing on every push would both waste work and trip Apple's
 * rate limit on token updates. The token is never logged.
 */
export class ApnsTokenProvider {
  private readonly key: KeyObject;
  private current: { jwt: string; issuedAt: number } | null = null;
  private stale = false;
  /** How many tokens this provider has signed. For tests and for the log. */
  signed = 0;

  constructor(
    keyPem: string,
    private readonly keyId: string,
    private readonly teamId: string,
    private readonly now: () => number = Date.now
  ) {
    this.key = createPrivateKey(keyPem);
  }

  token(): string {
    const now = this.now();
    const age = this.current ? now - this.current.issuedAt : Infinity;
    const due = age >= TOKEN_REFRESH_MS || (this.stale && age >= TOKEN_MIN_INTERVAL_MS);
    if (this.current && !due) return this.current.jwt;

    const header = b64url(JSON.stringify({ alg: "ES256", kid: this.keyId }));
    const claims = b64url(JSON.stringify({ iss: this.teamId, iat: Math.floor(now / 1000) }));
    const input = `${header}.${claims}`;
    // ieee-p1363: JOSE wants the raw r||s signature, not DER.
    const signature = sign("sha256", Buffer.from(input), { key: this.key, dsaEncoding: "ieee-p1363" });
    this.current = { jwt: `${input}.${b64url(signature)}`, issuedAt: now };
    this.stale = false;
    this.signed++;
    return this.current.jwt;
  }

  /** Apple said the token expired. Re-sign at the next chance the floor allows. */
  invalidate(): void {
    this.stale = true;
  }
}

// ─── The wire ────────────────────────────────────────────────────────────────

export const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

export interface ApnsWireResponse {
  status: number;
  body: string;
  headers: Record<string, string | undefined>;
}

/** One HTTP/2 request. Injected so tests never reach Apple. */
export type ApnsTransport = (
  origin: string,
  path: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
) => Promise<ApnsWireResponse>;

/**
 * The real transport: one long-lived HTTP/2 session per origin, as Apple asks
 * ("keep your connections with APNs open across multiple notifications"), and
 * replaced when it closes, errors or is sent GOAWAY.
 */
export function createHttp2Transport(): ApnsTransport & { close(): void } {
  const sessions = new Map<string, http2.ClientHttp2Session>();

  const sessionFor = (origin: string): http2.ClientHttp2Session => {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(origin);
    const forget = () => {
      if (sessions.get(origin) === session) sessions.delete(origin);
    };
    session.on("error", forget);
    session.on("close", forget);
    session.on("goaway", forget);
    // An idle connection must not hold the process open at shutdown.
    session.unref?.();
    sessions.set(origin, session);
    return session;
  };

  const transport = ((origin, path, headers, body, timeoutMs) =>
    new Promise<ApnsWireResponse>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      let session: http2.ClientHttp2Session;
      try {
        session = sessionFor(origin);
      } catch (err) {
        reject(err);
        return;
      }
      const req = session.request({ ":method": "POST", ":path": path, ...headers });
      const timer = setTimeout(() => {
        done(() => reject(new Error(`APNs request timed out after ${timeoutMs}ms`)));
        req.close(http2.constants.NGHTTP2_CANCEL);
      }, timeoutMs);
      let status = 0;
      const responseHeaders: Record<string, string | undefined> = {};
      let data = "";
      req.setEncoding("utf8");
      req.on("response", (h) => {
        status = Number(h[":status"]);
        for (const [k, v] of Object.entries(h)) {
          if (typeof v === "string") responseHeaders[k] = v;
        }
      });
      req.on("data", (chunk: string) => {
        data += chunk;
      });
      req.on("end", () => done(() => resolve({ status, body: data, headers: responseHeaders })));
      req.on("error", (err) => done(() => reject(err)));
      req.end(body);
    })) as ApnsTransport & { close(): void };

  transport.close = () => {
    for (const s of sessions.values()) s.close();
    sessions.clear();
  };
  return transport;
}

// ─── The client ──────────────────────────────────────────────────────────────

/**
 * Apple's answers that mean the token will never work again — for this topic
 * or at all. A pushkey behind one of these goes in the gateway's `rejected`,
 * which is what tells the homeserver to delete the pusher.
 */
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);

export type ApnsOutcome =
  | { status: "sent"; apnsId?: string }
  | { status: "rejected"; reason: string }
  | { status: "failed"; reason: string };

export interface ApnsSendInput {
  environment: ApnsEnvironment;
  deviceToken: string;
  priority: 5 | 10;
  collapseId?: string;
  /** Epoch seconds after which Apple should stop trying to deliver. */
  expiration: number;
  payload: unknown;
}

export interface ApnsClientOptions {
  tokens: ApnsTokenProvider;
  topic: string;
  transport: ApnsTransport;
  timeoutMs?: number;
  /** Retries after the first attempt, on 5xx, 429 and transport failures. */
  maxRetries?: number;
  /** Backoff before retry n (0-based): base · 2ⁿ, capped. */
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function reasonOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : "";
  } catch {
    return "";
  }
}

const MAX_BACKOFF_MS = 2_000;

export function createApnsClient(opts: ApnsClientOptions) {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const maxRetries = opts.maxRetries ?? 2;
  const base = opts.backoffBaseMs ?? 200;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function send(input: ApnsSendInput): Promise<ApnsOutcome> {
    const body = JSON.stringify(input.payload);
    let lastReason = "";
    let refreshedToken = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const headers: Record<string, string> = {
        authorization: `bearer ${opts.tokens.token()}`,
        "apns-topic": opts.topic,
        "apns-push-type": "alert",
        "apns-priority": String(input.priority),
        "apns-expiration": String(input.expiration),
        "content-type": "application/json",
      };
      if (input.collapseId) headers["apns-collapse-id"] = input.collapseId;

      let res: ApnsWireResponse;
      try {
        res = await opts.transport(
          APNS_HOSTS[input.environment],
          `/3/device/${input.deviceToken}`,
          headers,
          body,
          timeoutMs
        );
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
        if (attempt < maxRetries) await sleep(Math.min(base * 2 ** attempt, MAX_BACKOFF_MS));
        continue;
      }

      if (res.status === 200) return { status: "sent", apnsId: res.headers["apns-id"] };

      const reason = reasonOf(res.body) || `HTTP ${res.status}`;
      if (res.status === 410) return { status: "rejected", reason };
      if (res.status === 400 && DEAD_TOKEN_REASONS.has(reason)) return { status: "rejected", reason };

      if (res.status === 403 && reason === "ExpiredProviderToken" && !refreshedToken) {
        // Once: a second expiry in the same send means the clock is wrong, and
        // re-signing faster than every 20 minutes would only add a second error.
        refreshedToken = true;
        opts.tokens.invalidate();
        lastReason = reason;
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        lastReason = reason;
        if (attempt < maxRetries) {
          const retryAfter = Number(res.headers["retry-after"]);
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : base * 2 ** attempt;
          await sleep(Math.min(wait, MAX_BACKOFF_MS));
        }
        continue;
      }

      // Any other 4xx is ours to fix (a bad header, a bad topic); retrying it
      // changes nothing, and the device is not at fault either.
      return { status: "failed", reason };
    }
    return { status: "failed", reason: lastReason || "retries exhausted" };
  }

  return { send };
}

export type ApnsClient = ReturnType<typeof createApnsClient>;
