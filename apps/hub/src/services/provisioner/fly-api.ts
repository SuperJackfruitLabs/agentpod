/**
 * Low-level HTTP client for the Fly Machines API.
 *
 * Deliberately knows nothing about runtimes, manifests or the hub: it does auth,
 * rate pacing and turning a Fly failure into an error an operator can act on.
 * The driver in fly.ts owns everything above that.
 */

/**
 * The Authorization scheme Fly actually accepts.
 *
 * Fly's documentation gives BOTH "FlyV1 <token>" and "Bearer <token>", on
 * different pages, with no indication that either is deprecated. Guessing would
 * have produced a driver that 401s on its first live call with an error that
 * reads like a bad token.
 *
 * MEASURED, not read. Probed against the live API on 2026-08-13 with a
 * one-hour org token, `GET https://api.machines.dev/v1/apps?org_slug=personal`:
 *
 *   Authorization: Bearer <token>   → 200
 *   Authorization: FlyV1 <token>    → 200
 *   (no Authorization header)       → 401
 *   Authorization: Bearer garbage   → 401
 *
 * Both schemes are accepted. Per the plan's decision rule, "Bearer" is used: it
 * is the standard scheme and works with every HTTP tool without explanation.
 * The two 401 controls are there so the pair of 200s cannot be misread as an
 * endpoint that ignores auth altogether.
 *
 * One more measured wrinkle, because it will bite an operator pasting a token:
 * `flyctl tokens create org` prints the macaroon ALREADY prefixed with
 * "FlyV1 ". Sending that verbatim after this scheme — i.e. the literal header
 * "Authorization: Bearer FlyV1 <macaroon>" — also returned 200 on 2026-08-13,
 * so Fly tolerates the doubled scheme. Do not rely on that; FLY_API_TOKEN
 * should hold the bare macaroon.
 */
export const FLY_AUTH_SCHEME = "Bearer";

/** Default API host. Overridable so tests never depend on the constant. */
const FLY_API_BASE = "https://api.machines.dev";

/**
 * A Fly API failure, carrying the status so callers can branch on it.
 *
 * The status is not decoration. `wait?state=` answers 408 for "not yet", which
 * is a normal outcome the driver must swallow; a 404 on a machine means it is
 * already gone, which is what makes destroy idempotent. Without the status on
 * the error, both would be indistinguishable from a 500.
 */
export class FlyApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string
  ) {
    super(message);
    this.name = "FlyApiError";
  }
}

/** Something that must be awaited before each API call. See createFlyPacer. */
export interface Pacer {
  take(): Promise<void>;
}

/**
 * A pacer that never waits.
 *
 * For tests ONLY. Fly allows one request per second per action, so the real
 * pacer sleeps — and assertConforms provisions five times, which would put half
 * a minute of sleeping into every CI run for no signal at all.
 */
export const noPacer: Pacer = { take: async () => {} };

export type FlyRequest = (
  method: string,
  path: string,
  body?: unknown
) => Promise<{ status: number; body: Record<string, unknown> }>;

export interface FlyClientOptions {
  /** Fly API token. Never logged. */
  token: string;
  baseUrl?: string;
  /** Injectable fetch — used to inject a fake in unit tests. */
  fetchImpl?: typeof globalThis.fetch;
  pacer?: Pacer;
}

/**
 * Turn a Fly failure into something an operator can act on.
 *
 * The region case is the one that has already cost time: Fly refuses a region
 * the account's plan does not cover with a sentence about "legacy or non-paid
 * plan" and no mention of the knob. Measured 2026-08-12: "bom" refused, "sin"
 * accepted, on the same account.
 */
function describeFlyFailure(
  status: number,
  path: string,
  parsed: Record<string, unknown>,
  raw: string
): string {
  const detail =
    typeof parsed.error === "string" && parsed.error
      ? parsed.error
      : raw || "(no response body)";

  if (/legacy or non-paid plan/i.test(detail)) {
    return (
      `fly: ${status} for ${path}: ${detail} — this region is not available on ` +
      `this account's plan. Set FLY_REGION to a region the plan allows ("sin" ` +
      `was measured to work on a non-paid account) or upgrade the Fly ` +
      `organisation.`
    );
  }

  return `fly: ${status} for ${path}: ${detail}`;
}

export function createFlyClient({
  token,
  baseUrl = FLY_API_BASE,
  fetchImpl = globalThis.fetch,
  pacer = noPacer,
}: FlyClientOptions): FlyRequest {
  const base = baseUrl.replace(/\/$/, "");

  return async function flyRequest(method, path, body) {
    await pacer.take();

    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `${FLY_AUTH_SCHEME} ${token}`,
      },
      // NOTE: `body` carries the enrolment token on machine creation and is
      // never logged from this module. Do not add a log statement here.
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    // Read as text first: Fly answers some verbs with no content at all, and a
    // gateway in front of it can answer with HTML. Neither is a reason to throw
    // a parse error over the real status.
    const raw = await res.text();
    let parsed: Record<string, unknown> = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }

    if (!res.ok) {
      throw new FlyApiError(
        res.status,
        path,
        describeFlyFailure(res.status, path, parsed, raw)
      );
    }

    return { status: res.status, body: parsed };
  };
}
