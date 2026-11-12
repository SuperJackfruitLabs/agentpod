import { describe, expect, test } from "bun:test";
import { catalogFrom, grantProof, isolationOf, stationCapabilities } from "./build";
import type { StationFacts } from "./types";

const bare: StationFacts = {
  stationId: "stn_1",
  principalId: "prn_000000000000000000a1",
  harness: "hermes",
  runtime: null,
  fingerprint: null,
  skills: [],
  mcpProxy: null,
  boardTools: false,
  forgeGrants: [],
};

describe("isolation", () => {
  test("an enrolled host with no provisioned runtime is host, and only declared", () => {
    expect(isolationOf(null)).toEqual({ level: "host", runtime: null, proof: "declared" });
  });
  test("gVisor and microVM runtimes are a sandbox", () => {
    for (const runtime of ["runsc", "modal-sandbox", "fly-machine", "cloudflare-container"])
      expect(isolationOf({ provider: "x", runtime }).level).toBe("sandbox");
  });
  test("a plain container runtime is a container, named by its provider when it reports no runtime", () => {
    expect(isolationOf({ provider: "docker", runtime: "" })).toEqual({ level: "container", runtime: "docker", proof: "installed" });
    expect(isolationOf({ provider: "docker", runtime: "runc" })).toEqual({ level: "container", runtime: "runc", proof: "installed" });
  });
});

describe("proof", () => {
  test("a verified grant is probed, a delivered one installed, anything earlier declared", () => {
    expect(grantProof("verified")).toBe("probed");
    expect(grantProof("delivered")).toBe("installed");
    expect(grantProof("authorised")).toBe("declared");
    expect(grantProof("provisioned")).toBe("declared");
  });
});

describe("a station's registry row", () => {
  test("a bare station has its harness only", () => {
    expect(stationCapabilities(bare)).toEqual({
      stationId: "stn_1",
      principalId: "prn_000000000000000000a1",
      harness: "hermes",
      isolation: { level: "host", runtime: null, proof: "declared" },
      model: null,
      tools: [{ id: "harness:hermes", proof: "installed" }],
      credentials: [],
    });
  });

  test("a model the harness reported is probed; one the hub filled in is declared", () => {
    const harness = stationCapabilities({ ...bare, fingerprint: { model: "gpt-5", harnessVersion: "1.2.0", reportedBy: "harness" } });
    expect(harness.model).toEqual({ id: "gpt-5", proof: "probed" });
    expect(harness.tools).toContainEqual({ id: "harness:hermes", proof: "probed" });
    const hub = stationCapabilities({ ...bare, fingerprint: { model: "gpt-5", harnessVersion: "", reportedBy: "hub" } });
    expect(hub.model).toEqual({ id: "gpt-5", proof: "declared" });
    expect(hub.tools).toContainEqual({ id: "harness:hermes", proof: "installed" });
  });

  test("skills, board tools, the MCP proxy and broker grants become tools and credential names", () => {
    const row = stationCapabilities({
      ...bare,
      skills: [{ profile: "engineering", releaseVersion: "0.1.0" }],
      mcpProxy: true,
      boardTools: true,
      forgeGrants: [
        { provider: "github", instance: "https://github.com", state: "delivered" },
        { provider: "forgejo", instance: "https://forge.example", state: "verified" },
      ],
    });
    expect(row.tools.map((t) => t.id)).toEqual([
      "cli:stk",
      "harness:hermes",
      "mcp:agentpod-proxy",
      "mcp:superpipeline",
      "service:forge-api",
      "skill:engineering",
    ]);
    // Two grants: the broker's tools carry the stronger proof.
    expect(row.tools).toContainEqual({ id: "cli:stk", proof: "probed" });
    expect(row.credentials).toEqual([
      { name: "forge:forgejo", instance: "https://forge.example", proof: "probed" },
      { name: "forge:github", instance: "https://github.com", proof: "installed" },
    ]);
  });

  test("an MCP proxy declared off is not a tool", () => {
    expect(stationCapabilities({ ...bare, mcpProxy: false }).tools.map((t) => t.id)).toEqual(["harness:hermes"]);
  });

  test("no answer carries anything but names: no token-shaped field", () => {
    const text = JSON.stringify(
      stationCapabilities({ ...bare, boardTools: true, forgeGrants: [{ provider: "github", instance: "https://github.com", state: "verified" }] }),
    );
    expect(text).not.toMatch(/token|secret|sealed|handle/i);
  });
});

describe("the catalog", () => {
  test("one entry per id across stations, with the newest version and every credential name", () => {
    const entries = catalogFrom([
      { ...bare, fingerprint: { model: "m", harnessVersion: "1.9.0", reportedBy: "harness" }, forgeGrants: [{ provider: "github", instance: "https://github.com", state: "verified" }] },
      { ...bare, stationId: "stn_2", fingerprint: { model: "m", harnessVersion: "1.10.0", reportedBy: "harness" }, forgeGrants: [{ provider: "forgejo", instance: "https://f", state: "delivered" }] },
      { ...bare, stationId: "stn_3", harness: "salaam", skills: [{ profile: "ops", releaseVersion: null }] },
    ]);
    expect(entries.map((e) => e.id)).toEqual(["cli:stk", "harness:hermes", "harness:salaam", "service:forge-api", "skill:ops"]);
    expect(entries.find((e) => e.id === "harness:hermes")?.version).toBe("1.10.0");
    expect(entries.find((e) => e.id === "service:forge-api")).toEqual({
      id: "service:forge-api",
      kind: "service",
      name: "forge-api",
      version: null,
      source: "supertoolkit",
      licence: "Apache-2.0",
      credentials: ["forge:forgejo", "forge:github"],
    });
    expect(entries.find((e) => e.id === "skill:ops")).toMatchObject({ kind: "skill", source: "upload", version: null });
  });

  test("a licence nobody checked is null, never guessed", () => {
    expect(catalogFrom([bare])[0]).toMatchObject({ id: "harness:hermes", licence: null });
    expect(catalogFrom([{ ...bare, harness: "salaam" }])[0]).toMatchObject({ licence: "Apache-2.0" });
  });

  test("a skill from a trusted release names it as its source and version", () => {
    expect(catalogFrom([{ ...bare, skills: [{ profile: "eng", releaseVersion: "0.2.0" }] }])).toContainEqual(
      expect.objectContaining({ id: "skill:eng", source: "trusted-release", version: "0.2.0" }),
    );
  });

  test("an empty workspace has an empty catalog", () => {
    expect(catalogFrom([])).toEqual([]);
  });
});
