import { test, expect } from "bun:test";
import { PostureReport, PostureFinding, NodeCapabilityList } from "./posture";
import { HelloMsg } from "./gateway";
import { NodeSummary } from "./node";
import { VERB_PARAMS, VERB_RESULTS } from "./protocol";

const FINDING = {
  check: "creds.world-readable",
  status: "fail" as const,
  severity: "critical" as const,
  harness: "hermes",
  station: "hermes:analyst-echo",
  title: "Credentials readable by other users",
  detail: "mode 0644 and reachable",
  path: "/root/.hermes/profiles/analyst-echo/auth.json",
  remedy: "chmod 600 /root/.hermes/profiles/analyst-echo/auth.json",
};

test("a finding can name the station it belongs to", () => {
  // The console joins findings to stations by this key.
  expect(PostureFinding.parse(FINDING).station).toBe("hermes:analyst-echo");
});

test("host-level findings carry no station", () => {
  const { station, ...hostLevel } = FINDING;
  expect(PostureFinding.parse(hostLevel).station).toBeUndefined();
});

test("unknown is a first-class status, distinct from pass", () => {
  // A check that could not determine an answer must never be recorded as a pass.
  const f = PostureFinding.parse({ ...FINDING, status: "unknown", severity: "info" });
  expect(f.status).toBe("unknown");
});

test("a report carries the grade and the host it describes", () => {
  const r = PostureReport.parse({
    hostname: "molt-bot",
    stations: 15,
    findings: [FINDING],
    grade: "F",
  });
  expect(r.grade).toBe("F");
  expect(r.findings).toHaveLength(1);
});

test("hello may carry node capabilities, and may omit them", () => {
  // Omitted is how an older node degrades silently rather than erroring.
  const withCaps = HelloMsg.parse({
    type: "hello",
    hostInfo: { hostname: "h", os: "linux", arch: "amd64", cpuCount: 2 },
    version: "v0.1.22",
    capabilities: ["posture"],
  });
  expect(withCaps.capabilities).toEqual(["posture"]);

  const without = HelloMsg.parse({
    type: "hello",
    hostInfo: { hostname: "h", os: "linux", arch: "amd64", cpuCount: 2 },
  });
  expect(without.capabilities).toBeUndefined();
});

test("unknown node capabilities are filtered, not rejected", () => {
  // Same carry-in rule as station capabilities: an old hub must not break when
  // a newer node advertises something it has never heard of.
  expect(NodeCapabilityList.parse(["posture", "time-travel"])).toEqual(["posture"]);
});

test("NodeSummary exposes capabilities to the console", () => {
  const n = NodeSummary.parse({
    id: "node_1", name: "n", hostname: "h", os: "linux", arch: "amd64",
    cpuCount: 2, status: "online", lastSeenAt: null, createdAt: "now",
    agentVersion: "v0.1.22", latestVersion: null, updateAvailable: false,
    capabilities: ["posture"],
  });
  expect(n.capabilities).toEqual(["posture"]);
});

test("the posture verb is registered", () => {
  expect(VERB_PARAMS["posture.scan"].parse({})).toEqual({});
  expect(VERB_RESULTS["posture.scan"]).toBeDefined();
});
