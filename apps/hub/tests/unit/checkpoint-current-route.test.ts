import { expect, test } from "bun:test";
import { Hono } from "hono";
import { checkpointCurrentRoutes } from "../../src/routes/checkpoint-current";

const app = new Hono().route("/api", checkpointCurrentRoutes);
test("proposed current callback is absent by default and never caches decisions", async () => {
  const prior = process.env.PROPOSED_CHECKPOINT_COORDINATOR;
  delete process.env.PROPOSED_CHECKPOINT_COORDINATOR;
  try {
    const response = await app.request("/api/nodes/node_fixture/bench-coordinator/current", { method: "POST" });
    expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toBe("no-store");
  } finally { if (prior === undefined) delete process.env.PROPOSED_CHECKPOINT_COORDINATOR; else process.env.PROPOSED_CHECKPOINT_COORDINATOR = prior; }
});
test.each(["Bearer foreign_node:fixture-secret", "Bearer node_fixture", "Basic fixture-secret"])("node path mismatch/malformed credential is refused before source reads: %s", async (authorization) => {
  const prior = process.env.PROPOSED_CHECKPOINT_COORDINATOR;
  process.env.PROPOSED_CHECKPOINT_COORDINATOR = "true";
  try {
    const response = await app.request("/api/nodes/node_fixture/bench-coordinator/current", { method: "POST", headers: { authorization }, body: "invalid body must not be read first" });
    expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("fixture-secret");
  } finally { if (prior === undefined) delete process.env.PROPOSED_CHECKPOINT_COORDINATOR; else process.env.PROPOSED_CHECKPOINT_COORDINATOR = prior; }
});
