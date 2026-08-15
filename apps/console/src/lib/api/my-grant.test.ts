import { test, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./client", () => ({ http: vi.fn() }));

import { http } from "./client";
import { myReach, forgetMyReach } from "./my-grant";

/**
 * What this browser's principal may do, according to the issuer.
 *
 * Advisory only — the hub decides. This exists so a control that would be
 * refused can say so before it is clicked, which is the difference between a
 * greyed button with a reason and a 403 that looks like a bug.
 *
 * The interesting case is the failure one. Guessing "denied" when we cannot find
 * out would hide a control the operator actually holds, possibly on a deployment
 * where the pair is not even enforced — a worse wrong answer than letting the
 * hub refuse.
 */

function tokenWith(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/=+$/, "");
  return `header.${payload}.signature`;
}

beforeEach(() => {
  forgetMyReach();
  vi.clearAllMocks();
});
afterEach(() => forgetMyReach());

test("reports the claim the issuer put in the token", async () => {
  vi.mocked(http).mockResolvedValue({ token: tokenWith({ mayGrantReach: true }) });
  expect((await myReach()).mayGrantReach).toBe(true);
});

test("reports false when the claim says false", async () => {
  vi.mocked(http).mockResolvedValue({ token: tokenWith({ mayGrantReach: false }) });
  expect((await myReach()).mayGrantReach).toBe(false);
});

test("assumes permitted when it cannot find out, and lets the hub refuse", async () => {
  vi.mocked(http).mockRejectedValue(new Error("hub unreachable"));
  expect((await myReach()).mayGrantReach).toBe(true);
});

test("assumes permitted when the token carries no such claim", async () => {
  // An older hub that does not issue the pair must not have its console decide
  // everything is forbidden.
  vi.mocked(http).mockResolvedValue({ token: tokenWith({ sub: "user_1" }) });
  expect((await myReach()).mayGrantReach).toBe(true);
});

test("asks once per page load", async () => {
  vi.mocked(http).mockResolvedValue({ token: tokenWith({ mayGrantReach: true }) });

  await myReach();
  await myReach();
  await myReach();

  expect(http).toHaveBeenCalledTimes(1);
});
