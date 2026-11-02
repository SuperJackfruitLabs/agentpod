/**
 * Asking a node to verify a grant (`forge.api.verify`) and classifying the answer: stk's reason
 * codes, and the bypass evidence a node reports. Writes nothing.
 */
import {
  ForgeApiVerifyReasons,
  VERB_PARAMS,
  VERB_RESULTS,
  type ForgeApiVerifyReason,
} from "@agentpod/contract";

import { expectLoginFor, isUnknownVerb, scrub, untrusted } from "./grant-common";
import { FORGE_VERIFY_TIMEOUT_MS, TRANSIENT } from "./grant-node";
import type { BrokerReply, ForgeApiDeps, Grant } from "./grant-types";

// ─── verify ───────────────────────────────────────────────────────────────────

/**
 * stk's verify reason codes (`ForgeApiVerifyReasons`, the first token of `reason`), mapped:
 * - definitive — the grant fails: unauthorized, forbidden, wrong-identity, repository-missing, and
 *   the misconfigurations redirect and unsupported;
 * - of those, `NEW_TOKEN_BAD` (unauthorized, wrong-identity) condemn a rotation's NEW token;
 * - transient — the PROVIDER could not be asked, state unchanged (`provider-unavailable`):
 *   unreachable, server-error, unexpected-response;
 * - any other code (a newer stk) — `inconclusive`, state unchanged.
 */
const VERIFY_DEFINITIVE = new Set<ForgeApiVerifyReason>([
  "unauthorized",
  "forbidden",
  "wrong-identity",
  "repository-missing",
  "redirect",
  "unsupported",
]);
export const NEW_TOKEN_BAD = new Set<string>(["unauthorized", "wrong-identity"] satisfies ForgeApiVerifyReason[]);
const VERIFY_PROVIDER_DOWN = new Set<ForgeApiVerifyReason>(["unreachable", "server-error", "unexpected-response"]);
// Every stk code is mapped one way or the other.
ForgeApiVerifyReasons.forEach((r) => {
  if (!VERIFY_DEFINITIVE.has(r) && !VERIFY_PROVIDER_DOWN.has(r)) throw new Error(`forge: unmapped verify reason ${r}`);
});

// ─── bypass evidence (contract ForgeApiBypass) ───────────────────────────────
//
// Ruling: no new column. Bypass/coverage text goes in state_reason, built only from sanitised
// client names, path names and fixed words:
// - `bypassed: <clients>`           definitive: the grant fails (a verified one is downgraded);
// - `not-wired: <paths>`            inconclusive: state unchanged; written only as a NOTE;
// - `coverage-incomplete: <words>`  ok but not brokered: `delivered` (never `verified`);
// - `coverage: partial (untested: <clients>)` brokered, partly measured: `verified` + NOTE.
// A NOTE is written only where it cannot clobber a lifecycle reason: when the reason is empty or
// is itself a coverage note (the same rule updateGrantPolicy follows for policy-pending).
const COVERAGE_NOTES = ["not-wired", "coverage-incomplete", "coverage:"];
export const isCoverageNote = (r: string | null) => r === null || COVERAGE_NOTES.some((p) => r.startsWith(p));

/** A node-reported name, reduced to a safe token: [A-Za-z0-9._+-], at most 32 characters. */
function safeName(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9._+-]/g, "");
  return clean.slice(0, 32) || "?";
}
function namesList(names: string[]): string {
  const uniq = [...new Set(names.map(safeName))];
  const shown = uniq.slice(0, 5).join(", ");
  return uniq.length > 5 ? `${shown} (+${uniq.length - 5})` : shown;
}
type Bypass = NonNullable<ReturnType<(typeof VERB_RESULTS)["forge.api.verify"]["parse"]>["bypass"]>;
const clientsWith = (b: Bypass | undefined, outcomes: string[]) =>
  (b?.clients ?? []).filter((c) => outcomes.includes(c.outcome)).map((c) => c.client);

/** Fixed words for why a verify was not brokered. */
function incompleteWords(b: Bypass): string {
  const words: string[] = [];
  for (const o of ["bypassed", "failed", "refused-ca"]) if (b.clients.some((c) => c.outcome === o)) words.push(o);
  if ((b.paths ?? []).some((p) => !p.wired) || b.wiringBlocked) words.push("unwired");
  if (b.clients.length === 0) words.push("probe-failed");
  return words.length ? words.join(", ") : "probe-failed";
}

function notWiredText(b: Bypass | undefined): string {
  const paths = (b?.paths ?? []).filter((p) => !p.wired).map((p) => p.path);
  let t = paths.length ? namesList(paths) : "no path routed";
  if (b?.wiringBlocked) t += ` (blocked by ${namesList(b.wiringBlocked.split(/[\s,]+/).filter(Boolean))})`;
  return `not-wired: ${t}`;
}

export type VerifyAnswer =
  | { kind: "ok"; login: string; isolation: "separate-user" | "same-user"; note?: string }
  /** The identity matched but the node did not show the broker carries the traffic. */
  | { kind: "unbrokered"; reason: string; isolation: "separate-user" | "same-user" }
  /** The grant fails. `code` is the definitive reason, `node-too-old`, or `verify-failed`. */
  | { kind: "failed"; code: string; reason: string }
  | { kind: "offline"; reason: string }
  | { kind: "provider-unavailable"; reason: string }
  /** The node answered no with a reason code the hub does not know: not evidence either way. */
  | { kind: "inconclusive"; reason: string; note?: string };

/** Ask the node to make a real read call as the grant's credential. Writes nothing. */
export async function askVerify(deps: ForgeApiDeps, row: Grant, station: { id: string; nodeId: string }): Promise<VerifyAnswer> {
  let expectLogin: string;
  try {
    expectLogin = expectLoginFor(deps, row);
  } catch (err) {
    return { kind: "failed", code: "verify-failed", reason: `verify-failed: ${scrub(err)}` };
  }
  const params = VERB_PARAMS["forge.api.verify"].safeParse({ stationId: station.id, grantId: row.id, expectLogin });
  if (!params.success) return { kind: "failed", code: "verify-failed", reason: "verify-failed: invalid verify frame; nothing was sent" };
  let res: BrokerReply;
  try {
    res = await deps.broker.request(station.nodeId, "forge.api.verify", params.data, { timeoutMs: FORGE_VERIFY_TIMEOUT_MS });
  } catch (err) {
    return { kind: "offline", reason: `verify not attempted: ${untrusted(scrub(err))}` };
  }
  if (!res.ok) {
    const error = untrusted(res.error ?? "node error");
    if (TRANSIENT.has(error)) return { kind: "offline", reason: `verify not attempted: ${error}` };
    if (isUnknownVerb(error)) {
      return { kind: "failed", code: "node-too-old", reason: "node-too-old: the node does not know forge.api.verify" };
    }
    return { kind: "failed", code: "verify-failed", reason: `verify-failed: ${error}` };
  }
  const parsed = VERB_RESULTS["forge.api.verify"].safeParse(res.data);
  if (!parsed.success) return { kind: "failed", code: "verify-failed", reason: "verify-failed: unreadable verify reply" };
  const r = parsed.data;
  if (r.ok !== true) {
    const text = untrusted(r.reason ?? "no reason given");
    const code = text.split(/[:\s]/)[0]!.toLowerCase();
    if (code === "bypassed") {
      const names = clientsWith(r.bypass, ["bypassed"]);
      return { kind: "failed", code, reason: `bypassed: ${names.length ? namesList(names) : "clients not reported"}` };
    }
    if (code === "not-wired") {
      const note = notWiredText(r.bypass);
      return { kind: "inconclusive", reason: note, note };
    }
    if (VERIFY_DEFINITIVE.has(code as ForgeApiVerifyReason)) return { kind: "failed", code, reason: code === "wrong-identity" ? text : `verify-failed: ${text}` };
    if (VERIFY_PROVIDER_DOWN.has(code as ForgeApiVerifyReason)) return { kind: "provider-unavailable", reason: `provider unavailable: ${text}` };
    return { kind: "inconclusive", reason: `verify inconclusive: ${text}` };
  }
  if (!r.login || r.login.toLowerCase() !== expectLogin.toLowerCase()) {
    return {
      kind: "failed",
      code: "wrong-identity",
      reason: `wrong-identity: expected ${untrusted(expectLogin)}, the forge answered as ${untrusted(r.login ?? "(nobody)")}`,
    };
  }
  // Older nodes send no bypass evidence: verified as before (cannot tell old from silent).
  if (r.bypass && r.bypass.brokered !== true) {
    return { kind: "unbrokered", reason: `coverage-incomplete: ${incompleteWords(r.bypass)}`, isolation: r.isolation };
  }
  const untested = clientsWith(r.bypass, ["untested"]);
  const note =
    r.bypass?.measured === "partial"
      ? `coverage: partial${untested.length ? ` (untested: ${namesList(untested)})` : ""}`
      : undefined;
  return { kind: "ok", login: r.login, isolation: r.isolation, note };
}
