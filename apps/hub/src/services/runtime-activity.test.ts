/**
 * Unit tests: runtime activity toucher.
 *
 * Cloudflare's idle timer counts only INCOMING requests, and a node-agent dials
 * out — so without this signal a station sleeps 15 minutes after start however
 * hard it is being used. That is exactly how a live station vanished mid-session
 * on 2026-08-12.
 *
 * The debounce is not an optimisation. One trivial Hermes prompt was measured at
 * 1,051 ACP events; without it, that is 1,051 requests at the worker.
 */

import { describe, it, expect } from "bun:test";
import { createActivityToucher } from "./runtime-activity";

function harness(
  lookupResult: { provider: string; externalId: string } | null,
  opts: { failTouch?: boolean } = {}
) {
  const touched: string[] = [];
  let now = 1_000_000;
  const toucher = createActivityToucher(
    {
      lookup: async () => lookupResult,
      touch: async (externalId: string) => {
        if (opts.failTouch) throw new Error("worker unreachable");
        touched.push(externalId);
      },
      now: () => now,
    },
    60_000
  );
  return { toucher, touched, advance: (ms: number) => (now += ms) };
}

const CF = { provider: "cloudflare", externalId: "rt_abc" };

describe("createActivityToucher", () => {
  it("touches the substrate for a cloudflare-backed node", async () => {
    const { toucher, touched } = harness(CF);
    await toucher.touch("node_1");
    expect(touched).toEqual(["rt_abc"]);
  });

  it("debounces repeat activity within the interval", async () => {
    // The point: a chat firehose must not become a request firehose.
    const { toucher, touched, advance } = harness(CF);
    await toucher.touch("node_1");
    advance(30_000);
    await toucher.touch("node_1");
    await toucher.touch("node_1");
    expect(touched).toEqual(["rt_abc"]);
  });

  it("touches again once the interval has passed", async () => {
    const { toucher, touched, advance } = harness(CF);
    await toucher.touch("node_1");
    advance(60_001);
    await toucher.touch("node_1");
    expect(touched).toEqual(["rt_abc", "rt_abc"]);
  });

  it("does nothing for a node that is not cloudflare-backed", async () => {
    // Docker runtimes never sleep, and a docker node has no worker to call.
    const { toucher, touched } = harness({ provider: "docker", externalId: "rt_d" });
    await toucher.touch("node_1");
    expect(touched).toEqual([]);
  });

  it("does nothing for a node with no provisioned runtime", async () => {
    // Every enrolled laptop and VPS in the fleet takes this path.
    const { toucher, touched } = harness(null);
    await toucher.touch("node_1");
    expect(touched).toEqual([]);
  });

  it("NEVER throws when the substrate call fails", async () => {
    // A renewal is best-effort. If this could throw, an unreachable worker
    // would break the user's actual verb — the feature would cause the outage
    // it exists to prevent.
    const { toucher } = harness(CF, { failTouch: true });
    expect(toucher.touch("node_1")).resolves.toBeUndefined();
  });
});
