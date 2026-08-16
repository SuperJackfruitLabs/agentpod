import { beforeEach, describe, expect, test } from "bun:test";
import { recordTransaction, bridgeHealth, _resetHealthForTest } from "./health";

/**
 * Is the bridge working, or merely running?
 *
 * The distinction is not academic: the homeserver's registration carried
 * `url: null` for months, which meant a perfectly healthy Application Service
 * that had never been sent a single event — and nothing anywhere said so. A
 * bridge that cannot tell "quiet" from "not connected" reproduces exactly that.
 */

const HOUR = 60 * 60 * 1000;

beforeEach(() => _resetHealthForTest());

describe("bridge health", () => {
  test("starts as never-heard-from rather than healthy", () => {
    // Optimism here is what let url:null hide. A bridge that has received
    // nothing has not been proven to be reachable at all.
    const h = bridgeHealth({ enabled: true, now: 0 });
    expect(h.status).toBe("silent");
    expect(h.reason).toMatch(/no transaction/i);
  });

  test("is healthy once the homeserver has pushed something", () => {
    recordTransaction(1_000);
    expect(bridgeHealth({ enabled: true, now: 2_000 }).status).toBe("ok");
  });

  test("goes silent again after a long quiet spell", () => {
    // Two hours with no push, on a fleet of 32 agents, is not quiet — it is
    // disconnected. Better a false alarm an operator can dismiss than a bridge
    // that reports health it cannot demonstrate.
    recordTransaction(1_000);
    const h = bridgeHealth({ enabled: true, now: 1_000 + 3 * HOUR });
    expect(h.status).toBe("silent");
    expect(h.lastTransactionAt).toBe(1_000);
  });

  test("reports disabled when the bridge is off, not silent", () => {
    // An operator who has not enabled it must not be told it is broken.
    expect(bridgeHealth({ enabled: false, now: 0 }).status).toBe("disabled");
  });
});
