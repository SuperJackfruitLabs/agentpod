/**
 * Every capability the node puts in its hello frame must be one `NodeCapability` knows.
 *
 * `NodeCapabilityList` filters out a name it does not know, on purpose, so an older hub keeps
 * working with a newer node. The cost is that a capability added on the node and forgotten here
 * fails silently: the hub stores the node without it and treats it as a node that predates it.
 * That is what happened to `bench.registry.manage`. This reads the node's own sources, so the
 * two lists cannot drift apart unnoticed.
 */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NodeCapability, NodeCapabilityList } from "./posture";

const node = join(import.meta.dir, "../../../apps/node-agent");

/** A Go constant `Name = "value"` in one package, for an identifier like `benchbridge.ManageCapability`. */
function goConstant(qualified: string): string {
  const [pkg, name] = qualified.split(".");
  const dir = join(node, "internal", pkg ?? "");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))) {
    const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`).exec(readFileSync(join(dir, file), "utf8"));
    if (m?.[1]) return m[1];
  }
  throw new Error(`no constant ${qualified} in ${dir}`);
}

/** The capabilities the node advertises: gateway.NodeCapabilities plus every extras.Capabilities append. */
function advertisedByNode(): string[] {
  const posture = readFileSync(join(node, "internal/gateway/posture.go"), "utf8");
  const base = /var NodeCapabilities = \[\]string\{([^}]*)\}/.exec(posture)?.[1] ?? "";
  const out = [...base.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
  const run = readFileSync(join(node, "cmd/agentpod-node/run.go"), "utf8");
  for (const m of run.matchAll(/extras\.Capabilities = append\(extras\.Capabilities, ([^)]*)\)/g)) {
    for (const arg of (m[1] ?? "").split(",").map((a) => a.trim()).filter(Boolean)) {
      out.push(arg.startsWith('"') ? arg.slice(1, -1) : goConstant(arg));
    }
  }
  return out;
}

test("the reader finds what the node sends", () => {
  const sent = advertisedByNode();
  // Guards a vacuous pass: a reader that found nothing would leave nothing unknown.
  for (const name of ["posture", "frames.large", "mcp.proxy", "turn.errors", "bench.registry.manage"]) expect(sent).toContain(name);
});

test("every capability the node advertises survives the hub's parse of its hello", () => {
  const sent = advertisedByNode();
  expect(sent.filter((name) => !NodeCapability.safeParse(name).success)).toEqual([]);
  expect(NodeCapabilityList.parse(sent)).toEqual(sent);
});
