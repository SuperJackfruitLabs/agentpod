/**
 * Unit Tests: annotateWithVersion (node-registry — self-update slice 3)
 *
 * Tests the pure annotation helper that maps latestVersion + updateAvailable
 * onto node rows.  No database or network required.
 *
 * Verifies:
 *   1. Node with an older agentVersion → updateAvailable:true, latestVersion set.
 *   2. Node with the same agentVersion as latestVersion → updateAvailable:false.
 *   3. Node with null agentVersion → updateAvailable:false.
 *   4. latestVersion null → updateAvailable:false on all nodes.
 *   5. Multiple nodes in one call (batch annotation).
 */

import { test, expect } from "bun:test";
import { annotateWithVersion } from "../../src/services/nodes/registry";

// ─── Tests ────────────────────────────────────────────────────────────────────

test("node with older agentVersion → updateAvailable:true", () => {
  const result = annotateWithVersion([{ agentVersion: "v0.1.2" }], "v0.1.3");
  expect(result[0]!.latestVersion).toBe("v0.1.3");
  expect(result[0]!.updateAvailable).toBe(true);
});

test("node with same agentVersion as latestVersion → updateAvailable:false", () => {
  const result = annotateWithVersion([{ agentVersion: "v0.1.3" }], "v0.1.3");
  expect(result[0]!.updateAvailable).toBe(false);
  expect(result[0]!.latestVersion).toBe("v0.1.3");
});

test("node with null agentVersion → updateAvailable:false", () => {
  const result = annotateWithVersion([{ agentVersion: null }], "v0.1.3");
  expect(result[0]!.updateAvailable).toBe(false);
  expect(result[0]!.latestVersion).toBe("v0.1.3");
});

test("latestVersion null → updateAvailable:false on all nodes", () => {
  const result = annotateWithVersion(
    [{ agentVersion: "v0.1.2" }, { agentVersion: null }],
    null
  );
  expect(result[0]!.updateAvailable).toBe(false);
  expect(result[0]!.latestVersion).toBeNull();
  expect(result[1]!.updateAvailable).toBe(false);
});

test("passes through extra node fields unchanged", () => {
  const node = { agentVersion: "v0.1.2", id: "n1", name: "mynode" };
  const [annotated] = annotateWithVersion([node], "v0.1.3");
  expect(annotated!.id).toBe("n1");
  expect(annotated!.name).toBe("mynode");
  expect(annotated!.updateAvailable).toBe(true);
});

test("batch: multiple nodes annotated correctly in one call", () => {
  const nodes = [
    { agentVersion: "v0.1.2" }, // needs update
    { agentVersion: "v0.1.3" }, // up to date
    { agentVersion: null },      // unknown version
  ];
  const result = annotateWithVersion(nodes, "v0.1.3");
  expect(result[0]!.updateAvailable).toBe(true);
  expect(result[1]!.updateAvailable).toBe(false);
  expect(result[2]!.updateAvailable).toBe(false);
  // latestVersion is the same for all
  result.forEach((r) => expect(r.latestVersion).toBe("v0.1.3"));
});
