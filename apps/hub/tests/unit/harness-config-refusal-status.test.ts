/**
 * Unit test: `statusForRefusal` (src/services/harness-config-apply.ts).
 *
 * Minor 4. The function is exported, decides the status of every refusal a
 * NODE names, and had no test of its own: only 2 of the contract's 8 codes
 * were exercised at all, through two route tests, and the two that were wrong
 * were among the six that were not.
 *
 * The rule it implements is "could re-sending this exact request ever work?" —
 * 400 when it could not, 409 when it lost to the state of the document or the
 * station. Every code is named here, so the mapping cannot drift from the
 * sentence that explains it, and the table is driven from
 * `ConfigRefusalCode.options` so a code added to the contract fails this test
 * until someone decides its status.
 */
import { describe, test, expect } from "bun:test";
import { ConfigRefusalCode } from "@agentpod/contract";
import { statusForRefusal } from "../../src/services/harness-config-apply";

/** Every code, with the status the documented rule gives it. */
const EXPECTED: Record<string, 400 | 409> = {
  // Cannot succeed as asked, however the station changes.
  UNKNOWN_SETTING: 400,
  OUT_OF_SCOPE: 400,
  SHAPE_UNEXPECTED: 400,
  OPTED_OUT: 400,
  CREDENTIAL_PATH: 400,
  // Well-formed; lost to state. Re-read and re-send.
  PLAN_STALE: 409,
  PLAN_DIGEST_MISMATCH: 409,
  UNREADABLE: 409,
};

describe("the status a node's refusal answers with", () => {
  test("every contract refusal code has a decided status", () => {
    // Not `Object.keys(EXPECTED)`: the contract is the authority on the set,
    // so a new code is a failure here rather than a silent 409.
    expect(Object.keys(EXPECTED).sort()).toEqual([...ConfigRefusalCode.options].sort());
  });

  for (const code of ConfigRefusalCode.options) {
    test(`${code} answers ${EXPECTED[code]}`, () => {
      expect(statusForRefusal(code)).toBe(EXPECTED[code]!);
    });
  }

  test("a mis-declared value is the caller's to fix, not a conflict", () => {
    // The commonest `SHAPE_UNEXPECTED` is "declared value is not a list of
    // strings", remedy `fleet config set`. It used to answer 409, telling a
    // caller that branches on status it had conflicted with something it does
    // not control.
    expect(statusForRefusal("SHAPE_UNEXPECTED")).toBe(400);
  });

  test("OPTED_OUT is one status whether the hub or the node noticed", () => {
    // The hub throws 400 for it in two places (`planFor`, `applyFor`); the
    // node's own OPTED_OUT used to fall through to `default: 409`, so one
    // code answered two statuses depending on who got there first.
    expect(statusForRefusal("OPTED_OUT")).toBe(400);
  });
});
