import { describe, expect, test } from "bun:test";

import type { SelfStation } from "../self-station";
import { linkFromOwnStation } from "./link-own";
import type { LinkInput, LinkResult } from "./link";

const STATION: SelfStation = {
  id: "stn_00000000000000a7", stationKey: "key:a7", nodeId: "nod_00000000000000a7", nodeName: "n", nodeStatus: "online",
  harness: "h", matrixId: null, identityMode: null, ownerUserId: "usr_o", tenantId: "ten_00000000000000a7", nodeCapabilities: ["fs.walk"],
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
    expect(t.seen[0]!.station).toEqual({ id: STATION.id, stationKey: "key:a7", nodeId: STATION.nodeId, nodeStatus: "online", tenantId: "ten_00000000000000a7", capabilities: ["fs.walk"] });
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

  test("a node that did not say its capabilities is passed as null, not as empty", async () => {
    const t = run({ ...STATION, nodeCapabilities: null });
    await t.go();
    expect(t.seen[0]!.station.capabilities).toBeNull();
  });
});
