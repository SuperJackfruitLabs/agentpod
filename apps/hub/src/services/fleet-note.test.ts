import { describe, expect, test } from "bun:test";
import { annotateFleetRows, deriveStatus } from "./fleet";
import type { CachedHealth } from "./health-cache";

/**
 * A node's health note has to reach a caller, or it does not exist.
 *
 * The node-agent sets `Health.Note` to explain a reading that would otherwise look
 * wrong — on a host running ONE multiplexed Hermes gateway, every profile reports
 * that gateway's cpu/memory/uptime, so fifteen agents show byte-identical figures.
 * The note is what separates "shared process" from "bug".
 *
 * It was dropped twice over: the health FRAME had no `note` key, so it never left the
 * node, and `deriveStatus` returned exactly four fields, so it would have been
 * discarded at the hub anyway. Both are fixed; these tests pin the hub half.
 */

const cached = (report: Partial<CachedHealth["report"]>, at = Date.now()): CachedHealth =>
  ({
    at,
    report: { key: "hermes:artistic-lyra", ok: true, running: true, pid: 3743876, cpuPct: 0.1, memBytes: 87400448, uptimeSec: 2100, ...report },
  }) as CachedHealth;

describe("deriveStatus carries the note", () => {
  test("passes a note through from a healthy report", () => {
    const note = 'served by the root Hermes gateway (station "hermes", PID 3743876; gateway.multiplex_profiles) — not separately startable; CPU/memory/uptime are the shared gateway\'s, not this agent\'s';
    expect(deriveStatus("online", cached({ note }), Date.now()).note).toBe(note);
  });

  test("a node that predates the field omits it, and that is null not undefined", () => {
    // v0.1.83 and earlier send no `note` key at all. `undefined` would serialise away
    // and make the field's absence indistinguishable from a node that never set it.
    const got = deriveStatus("online", cached({}), Date.now());
    expect(got.note).toBeNull();
  });

  test("null when there is nothing to explain", () => {
    expect(deriveStatus("online", cached({ note: null }), Date.now()).note).toBeNull();
  });

  test("null on an errored report, where the metrics are null too", () => {
    const got = deriveStatus("online", cached({ ok: false, note: "stale explanation" }), Date.now());
    expect(got.status).toBe("error");
    expect(got.note).toBeNull();
  });

  test("null when the node is offline or the report is stale", () => {
    const note = "shared gateway";
    expect(deriveStatus("offline", cached({ note }), Date.now()).note).toBeNull();
    // 10 minutes old — well past the staleness window.
    expect(deriveStatus("online", cached({ note }, Date.now() - 600_000), Date.now()).note).toBeNull();
  });
});

describe("the note survives the row projection", () => {
  // The bug this guards is specifically a field that exists everywhere EXCEPT the
  // shape a caller receives, so asserting on deriveStatus alone would not have
  // caught it. `fleet agents` reads annotateFleetRows' output.
  test("annotateFleetRows exposes it on the agent row", () => {
    const note = "served by the root Hermes gateway";
    const rows = [
      {
        stationId: "station_1",
        nodeId: "node_1",
        nodeName: "guild",
        stationKey: "hermes:artistic-lyra",
        agentName: "artistic-lyra",
        harness: "hermes",
        kind: "composite",
        nodeStatus: "online" as const,
        agentVersion: "v0.1.84",
        capabilities: ["acp"],
        workspacePath: "/root/.hermes/profiles/artistic-lyra",
      },
    ];
    const [agent] = annotateFleetRows(rows as never, "v0.1.84", () => cached({ note }), Date.now());
    expect(agent).toHaveProperty("note");
    expect((agent as { note: string | null }).note).toBe(note);
  });
});
