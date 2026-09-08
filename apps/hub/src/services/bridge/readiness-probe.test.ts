/**
 * The readiness probe is the one call in a cycle that must be fast.
 *
 * On 2026-09-08 the bridge logged a single cycle and then nothing at all — not an error, not an
 * idle poll — while the process stayed healthy. The probe asks a node over the broker whether
 * its station can run work; it had no timeout, so when it never answered, the agent was gone.
 * That is the one failure shape indistinguishable from a quiet fleet.
 *
 * The claim after it is bounded by `fetchAdapter`'s own signal. Everything after THAT is the
 * agent's work, which legitimately runs for as long as it runs — so the bound belongs here and
 * nowhere wider.
 */
import { describe, expect, test } from "bun:test";
import { READINESS_PROBE_TIMEOUT_MS, runOnce } from "./dispatch";

describe("READINESS_PROBE_TIMEOUT_MS", () => {
  test("is short enough to be about *right now*, and not zero", () => {
    // A readiness answer that takes a minute is not a readiness answer.
    expect(READINESS_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(READINESS_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("a probe that never answers", () => {
  const agent = {
    key: "a",
    boardId: "brd_x",
    token: "kbn_x",
    stationId: "station_x",
    hubUserId: "usr_x",
    mode: "full-auto" as const,
  };

  test("resolves as not-ready rather than hanging the cycle", async () => {
    const never = new Promise<{ ready: boolean }>(() => {});
    const result = await runOnce({
      client: {
        claim: async () => {
          throw new Error("must not reach the claim: the station is not ready");
        },
      } as never,
      acp: { stationReady: () => never } as never,
      agent: agent as never,
      tenantId: "tnt_x",
      source: "kaambaan",
      log: () => {},
    } as never);

    expect(result.status).toBe("not-ready");
    expect(result.reason).toContain("readiness probe");
  }, 20_000);

  test("a prompt answer is passed through untouched", async () => {
    const result = await runOnce({
      client: { claim: async () => null } as never,
      acp: { stationReady: async () => ({ ready: true }) } as never,
      agent: agent as never,
      tenantId: "tnt_x",
      source: "kaambaan",
      log: () => {},
    } as never);
    // ready → it went on to claim, and found nothing
    expect(result.status).toBe("idle");
  });
});
