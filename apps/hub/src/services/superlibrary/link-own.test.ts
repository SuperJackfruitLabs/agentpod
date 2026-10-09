import { describe, expect, test } from "bun:test";

import type { SelfStation } from "../self-station";
import { linkFromOwnStation } from "./link-own";
import { linkArtifact } from "./link";
import type { LinkInput, LinkResult } from "./link";

const STATION: SelfStation = {
  id: "stn_00000000000000a7", stationKey: "key:a7", nodeId: "nod_00000000000000a7", nodeName: "n", nodeStatus: "online",
  harness: "h", matrixId: null, identityMode: null, ownerUserId: "usr_o", tenantId: "ten_00000000000000a7", capabilities: ["acp", "fs.walk"],
};
const OK: LinkResult = { ok: true, itemId: "itm_0000000000000001", version: 1, url: "u", sha256: "s", mediaType: "text/plain", bytes: 1 };

function run(station: SelfStation | null, over: Partial<{ link: (i: LinkInput) => Promise<LinkResult> }> = {}) {
  const seen: LinkInput[] = [];
  const asked: string[] = [];
  return {
    seen, asked,
    go: () => linkFromOwnStation(
      {
        stationFor: async (p) => { asked.push(p); return station; },
        link: over.link ?? (async (i) => { seen.push(i); return OK; }),
      },
      { principalId: "prn_000000000000000000a7", path: "out/a.md" },
    ),
  };
}

describe("linkFromOwnStation", () => {
  test("the station and tenant come from the hub's record of the caller, and the actor is the agent", async () => {
    const t = run(STATION);
    await t.go();
    expect(t.asked).toEqual(["prn_000000000000000000a7"]);
    expect(t.seen[0]!.station).toEqual({ id: STATION.id, stationKey: "key:a7", nodeId: STATION.nodeId, nodeStatus: "online", tenantId: "ten_00000000000000a7", capabilities: ["acp", "fs.walk"] });
    expect(t.seen[0]!.actor).toEqual({ principal: "prn_000000000000000000a7", kind: "agent" });
  });

  test("a null node status becomes offline", async () => {
    const t = run({ ...STATION, nodeStatus: null });
    await t.go();
    expect(t.seen[0]!.station.nodeStatus).toBe("offline");
  });

  test("an agent with no station is told so, and nothing is linked", async () => {
    const t = run(null);
    const r = await t.go();
    expect(r).toMatchObject({ ok: false, status: 403, error: "no_station" });
    expect(t.seen).toEqual([]);
  });

  test("a station whose capabilities are unknown is passed as null, not as empty", async () => {
    const t = run({ ...STATION, capabilities: null });
    await t.go();
    expect(t.seen[0]!.station.capabilities).toBeNull();
  });
});

describe("the real linkArtifact behind it", () => {
  const NODE_CAPS = ["posture", "frames.large"]; // node-level enum: never holds fs.walk
  function real(station: SelfStation) {
    const calls: string[] = [];
    const broker = { request: async (_n: string, verb: string) => { calls.push(verb); return { ok: false, error: "node offline" }; } };
    const go = () => linkFromOwnStation(
      {
        stationFor: async () => station,
        link: (i) => linkArtifact({ broker: broker as never, client: {} as never, provenance: async () => ({ refused: "x" }) }, i),
      },
      { principalId: "prn_000000000000000000a7", path: "out/a.md" },
    );
    return { calls, go };
  }

  test("a station that declares fs.walk reaches the node, whatever the node-level list says", async () => {
    const t = real({ ...STATION, capabilities: ["acp", "fs.walk"] });
    const r = await t.go();
    expect(r).toMatchObject({ ok: false, error: "no_board" }); // past the capability check
    expect(NODE_CAPS).not.toContain("fs.walk");
  });

  test("a station without fs.walk is node_too_old and the broker is never called", async () => {
    const t = real({ ...STATION, capabilities: ["acp"] });
    const r = await t.go();
    expect(r).toMatchObject({ ok: false, error: "node_too_old" });
    expect(t.calls).toEqual([]);
  });
});
