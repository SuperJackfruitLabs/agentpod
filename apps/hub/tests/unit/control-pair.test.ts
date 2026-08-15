import { describe, expect, test } from "bun:test";
import {
  parseGrants,
  mayDispatch,
  mayGrantReach,
  isControlPairEnforced,
} from "../../src/services/control-pair";

/**
 * The control pair — Phase 3 of the Organization layer plan, implementing
 * Decision 4 of charter decisions/2026-08-13-ecosystem-identity.md.
 *
 * Two checks carry the weight that per-run delegation would otherwise have
 * carried, because agents hold their own reach:
 *
 *   1. who may DISPATCH which agent
 *   2. who may GRANT an agent its reach
 *
 * Both are required. Dispatch control alone is decorative: anyone who can
 * register an agent and grant it production credentials does not need
 * permission to dispatch anything — they build the agent they want.
 *
 * The grant lives as static configuration until an issuer can answer it, and
 * deliberately in the SHAPE OF THE EVENTUAL CLAIM (`mayDispatch`,
 * `mayGrantReach` — reserved in fixtures/ecosystem-identity/token_claims.json),
 * so adopting a real issuer is a data move rather than a redesign.
 */

const GRANTS = JSON.stringify({
  "user_alice": { mayDispatch: ["hermes:*"], mayGrantReach: true },
  "user_bob": { mayDispatch: ["hermes:analyst-echo"], mayGrantReach: false },
  "user_none": { mayDispatch: [], mayGrantReach: false },
});

describe("the control pair", () => {
  test("is off when nothing is configured, and says so", () => {
    // Introducing the first real authorization check in the suite must not be
    // the same event as turning it on everywhere. Unconfigured means off — the
    // same posture HUB_ISSUER and the tenant external mapping take — so a
    // standalone hub keeps working and enabling the control is a deliberate act.
    expect(isControlPairEnforced(undefined)).toBe(false);
    expect(isControlPairEnforced("")).toBe(false);
    expect(isControlPairEnforced(GRANTS)).toBe(true);
  });

  test("allows everything when unenforced, and nothing silently when enforced", () => {
    // The two regimes, stated as one assertion so the difference cannot drift.
    expect(mayDispatch(undefined, "user_alice", "hermes:analyst-echo")).toBe(true);
    expect(mayDispatch(GRANTS, "user_nobody", "hermes:analyst-echo")).toBe(false);
  });

  test("fails closed for a principal with no grant at all", () => {
    // Absence is not permission. The decision is explicit, and this is the case
    // it is explicit about: a caller nobody has granted anything is refused,
    // not waved through because there is no rule mentioning them.
    expect(mayDispatch(GRANTS, "user_unknown", "hermes:analyst-echo")).toBe(false);
    expect(mayGrantReach(GRANTS, "user_unknown")).toBe(false);
  });

  test("matches an exact station key", () => {
    expect(mayDispatch(GRANTS, "user_bob", "hermes:analyst-echo")).toBe(true);
    expect(mayDispatch(GRANTS, "user_bob", "hermes:coder-kai")).toBe(false);
  });

  test("matches a trailing wildcard, and only as a prefix", () => {
    expect(mayDispatch(GRANTS, "user_alice", "hermes:anything")).toBe(true);
    // `hermes:*` must not reach a different harness. A wildcard that matched
    // across the separator would grant openclaw and codex too.
    expect(mayDispatch(GRANTS, "user_alice", "openclaw:something")).toBe(false);
  });

  test("an empty grant list denies rather than permits", () => {
    // `[]` is a decision, and the decision is no. Reading it as "unrestricted"
    // is the classic inversion — it is also what an operator would write to
    // suspend someone.
    expect(mayDispatch(GRANTS, "user_none", "hermes:analyst-echo")).toBe(false);
  });

  test("carries the second half, which is not optional", () => {
    expect(mayGrantReach(GRANTS, "user_alice")).toBe(true);
    expect(mayGrantReach(GRANTS, "user_bob")).toBe(false);
  });

  test("refuses to parse a malformed grant rather than guessing at it", () => {
    // Half-understood authorization configuration is worse than none: it looks
    // enforced and is not. A parse failure must be loud at boot, not a quiet
    // fallback to permit.
    expect(() => parseGrants("{not json")).toThrow();
    expect(() => parseGrants(JSON.stringify({ user_x: { mayDispatch: "hermes:*" } }))).toThrow();
    expect(() => parseGrants(JSON.stringify({ user_x: { mayGrantReach: "yes" } }))).toThrow();
    expect(() => parseGrants(JSON.stringify(["not", "an", "object"]))).toThrow();
  });

  test("an unparseable configuration denies everything rather than allowing it", () => {
    // If the config cannot be read, the safe reading is that nobody is granted
    // anything — never that everybody is.
    expect(mayDispatch("{not json", "user_alice", "hermes:analyst-echo")).toBe(false);
    expect(mayGrantReach("{not json", "user_alice")).toBe(false);
  });
});
