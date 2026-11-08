import { describe, expect, test } from "bun:test";

import { relayTokenForBoard } from "./relay-scope";

/**
 * One decision for the relay (review of #845): the tenant the caller projects into must be the
 * relay's, and no other tenant on this hub may know the board — a board rostered or dispatched
 * under several tenants has no single owner, so it never gets the relay.
 */

function relay() {
  const asked: string[] = [];
  return {
    asked,
    relay: {
      tokenFor: async (tenantId: string) => {
        asked.push(tenantId);
        return tenantId === "fleet_relay" ? "relay.jwt.token" : null;
      },
      invalidate: () => {},
    },
  };
}

const KNOWN: Record<string, string[]> = {
  brd_mine: ["fleet_relay"],
  brd_theirs: ["fleet_other"],
  brd_shared: ["fleet_other", "fleet_relay"],
};
const tenantsForBoard = async (b: string) => KNOWN[b] ?? [];

describe("when the relay's token may be used for a board", () => {
  test("its own workspace's board, as resolved by the caller", async () => {
    const r = relay();
    expect(await relayTokenForBoard(r.relay, "fleet_relay", "brd_mine", tenantsForBoard)).toBe("relay.jwt.token");
  });

  test("never with no tenant, never for another workspace's board", async () => {
    const r = relay();
    expect(await relayTokenForBoard(r.relay, null, "brd_mine", tenantsForBoard)).toBeNull();
    expect(await relayTokenForBoard(r.relay, "fleet_other", "brd_theirs", tenantsForBoard)).toBeNull();
  });

  test("never for a board several tenants know — even when the caller resolved the relay's tenant", async () => {
    const r = relay();
    expect(await relayTokenForBoard(r.relay, "fleet_relay", "brd_shared", tenantsForBoard)).toBeNull();
    expect(r.asked).toEqual([]);
  });

  test("never when the caller's tenant is not the one tenant that knows the board", async () => {
    const r = relay();
    expect(await relayTokenForBoard(r.relay, "fleet_relay", "brd_theirs", tenantsForBoard)).toBeNull();
    expect(r.asked).toEqual([]);
  });
});
