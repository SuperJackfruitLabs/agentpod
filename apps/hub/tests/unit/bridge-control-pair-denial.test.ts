import { describe, expect, test } from "bun:test";
import { ControlPairDenied, isControlPairDenied } from "../../src/services/control-pair";

/**
 * A control-pair refusal is permanent, and the bridge must treat it that way.
 *
 * The defect this guards against was introduced by the change that added the
 * check (#337) and is invisible from the AgentPod side: `createSession` throws,
 * the bridge's `handBack` releases the claim, the board reissues the card, the
 * same agent claims it, the same principal is refused — a hot loop, bounded only
 * by a circuit breaker that a release may never trip.
 *
 * Every other failure at that point IS transient (the node went offline, the
 * station lost a capability), which is exactly why handing the claim back is the
 * right default and why a denial has to be told apart from one.
 */
describe("a control-pair denial is distinguishable", () => {
  test("is recognisable as itself", () => {
    const denied = new ControlPairDenied("user_x", "hermes:agent");
    expect(isControlPairDenied(denied)).toBe(true);
    expect(denied.principalId).toBe("user_x");
    expect(denied.stationKey).toBe("hermes:agent");
  });

  test("an ordinary failure is not mistaken for one", () => {
    // The transient cases must keep taking the release path. Reading them as
    // denials would fail cards permanently for a node that was briefly offline.
    expect(isControlPairDenied(new Error("Node is offline."))).toBe(false);
    expect(isControlPairDenied(new Error("Station not found."))).toBe(false);
    expect(isControlPairDenied(null)).toBe(false);
    expect(isControlPairDenied(undefined)).toBe(false);
    expect(isControlPairDenied("You do not have permission to dispatch this agent.")).toBe(false);
  });

  test("survives crossing a boundary that loses the prototype", () => {
    // Errors are re-thrown, wrapped and serialised on the way out of a service.
    // Matching on the name as well as the instance means the check still holds
    // when only the shape survives — a `instanceof`-only guard would silently
    // start releasing again.
    const shaped = { name: "ControlPairDenied", message: "…", principalId: "u", stationKey: "s" };
    expect(isControlPairDenied(shaped)).toBe(true);
  });

  test("carries what the board needs to explain the refusal", () => {
    // The denial is reported as structured activity, not a stringified
    // exception: charter decisions/2026-08-13-ecosystem-identity.md requires a
    // denial to come back as work activity and never be silently dropped. Both
    // fields are what make that message specific rather than "something failed".
    const denied = new ControlPairDenied("68jYD9VOCmXlPhIYGFOgoZVE6vDUVHPA", "hermes:analyst-echo");
    expect(denied.principalId).toBeTruthy();
    expect(denied.stationKey).toBeTruthy();
    expect(denied.message).toMatch(/permission/i);
  });
});
