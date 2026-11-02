/**
 * The shape of the TypeScript source, held by numbers that may only fall.
 *
 * Phase 0 of the modularity work (docs/contributor/code-quality.md): nothing is restructured
 * yet, so these are not rules about what the code should look like. They are ratchets on what it
 * looks like today. Each one fails in BOTH directions: a number that grows is a regression, and a
 * number that shrinks fails too, with a prompt to lower the recorded value, so the record can
 * never go stale and let the next regression in unnoticed.
 *
 *  - the largest file-level import cycle in each tree;
 *  - the hub's layer order (HUB_LAYERS): every import between its top-level folders points down,
 *    except the back-edges KNOWN_BACK_EDGES still lists (none since Phase 1);
 *  - the folder-level cycles: the hub's top-level folders, and the folders inside services/;
 *  - shipped files over SIZE_LIMIT lines, each held at its current size by OVERSIZE.
 *
 * Every import counts, `import type` included: a type-only edge is still a dependency a reader
 * has to follow, and it is the first thing a cycle-breaking change moves.
 *
 * The console and the packages are measured from here because this is the suite that runs in the
 * required `hub` job, the same reason docs-claims.test.ts reads the whole repository.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cycles, folderGraph, importGraph, sourceFiles } from "../helpers/import-graph";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const SIZE_LIMIT = 1000;

interface Tree {
  /** Repository-relative root of the source tree. */
  root: string;
  /** Import prefixes that name a folder in the tree, e.g. SvelteKit's `$lib`. */
  aliases?: Record<string, string>;
  /** Files in the largest file-level import cycle. Lower it; never raise it. */
  largestCycle: number;
  /** Shipped files over SIZE_LIMIT and the most lines each may have. Lower these; never raise them. */
  oversize: Record<string, number>;
}

const TREES: Tree[] = [
  {
    root: "apps/hub/src",
    largestCycle: 3,
    oversize: {
      "services/acp/sessions.ts": 3514,
      "services/bridge/dispatch.ts": 1338,
      "services/bridge/salaam-dispatch.ts": 1583,
      "services/matrix-as/gates.ts": 1139,
      "services/matrix-as/outbound.ts": 1147,
      "services/forge-api/station-forge-api.ts": 2082,
      "services/runtimes/runtimes.ts": 1317,
    },
  },
  {
    root: "apps/console/src",
    aliases: { $lib: "lib" },
    largestCycle: 3,
    oversize: { "routes/nodes/[id]/stations/[stationId]/+page.svelte": 1009 },
  },
  { root: "packages/contract/src", largestCycle: 0, oversize: {} },
  { root: "packages/agents/src", largestCycle: 0, oversize: {} },
  { root: "packages/ui/src", largestCycle: 2, oversize: {} },
  { root: "cloudflare/worker-v2/src", largestCycle: 0, oversize: {} },
];

/** Folder-level cycles: under `root`, each folder (or top-level file) is one node. Each entry
 *  lists the members of every cycle there, largest first. A cycle may lose members or vanish;
 *  it may not gain one, and no new cycle may appear. */
const FOLDER_CYCLES: { root: string; cycles: string[][] }[] = [
  { root: "apps/hub/src", cycles: [] },
  { root: "apps/hub/src/services", cycles: [] },
];

/**
 * The hub's top-level folders (and top-level files, by name without `.ts`), lowest layer first.
 * An import may point at its own entry or at one earlier in the list, never at a later one. A new
 * folder or top-level file must be placed here; docs/contributor/code-quality.md says why each
 * sits where it does.
 */
const HUB_LAYERS = [
  "config", //          env → settings; imports nothing
  "ws", //              the one shared Bun WebSocket helper; imports nothing
  "telemetry", //       OpenTelemetry setup, spans and propagation
  "utils", //           logger, ids, encryption: no domain
  "db", //              Drizzle client, schema, migrations
  "models", //          a table's own reads and writes
  "auth", //            token verification, caller authority, and the org plane it reads
  "services", //        the domain
  "mcp", //             the hub's MCP server, over services
  "middleware", //      HTTP middleware
  "routes", //          HTTP and WebSocket routes
  "validate-config", // boot validation: reads every subsystem's settings
  "index", //           the composition root: wires everything and serves
];

/** Imports that point UP the layer order, as "from -> to". May only shrink; Phase 1 emptied it.
 *  Fix a back-edge rather than adding one: move a pure helper or type down, move a misplaced file
 *  to its layer, or declare a narrow interface below and inject it from index.ts. */
const KNOWN_BACK_EDGES: string[] = [];

const lineCount = (path: string): number => readFileSync(path, "utf8").split("\n").length - 1;

describe("architecture ratchets", () => {
  for (const tree of TREES) {
    const rootDir = join(REPO, tree.root);

    test(`${tree.root}: the largest import cycle holds at ${tree.largestCycle} files`, () => {
      const largest = Math.max(0, ...cycles(importGraph(rootDir, tree.aliases)).map((c) => c.length));
      expect(largest, "the largest import cycle grew").toBeLessThanOrEqual(tree.largestCycle);
      expect(largest, "the cycle shrank; lower largestCycle to lock it in").toBe(tree.largestCycle);
    });

    test(`${tree.root}: no shipped file grows past ${SIZE_LIMIT} lines`, () => {
      const sizes = new Map(sourceFiles(rootDir).map((f) => [relative(rootDir, f), lineCount(f)] as const));
      const over = [...sizes].filter(([, n]) => n > SIZE_LIMIT);
      const grown = over
        .filter(([file, n]) => n > (tree.oversize[file] ?? SIZE_LIMIT))
        .map(([file, n]) => `${file}: ${n} lines, allowed ${tree.oversize[file] ?? SIZE_LIMIT}`);
      expect(grown, "these files grew past their limit; split them rather than raising it").toEqual([]);
      const stale = Object.entries(tree.oversize)
        .filter(([file, max]) => (sizes.get(file) ?? 0) < max)
        .map(([file, max]) => `${file}: ${sizes.get(file) ?? "gone"} lines, recorded ${max}`);
      expect(stale, "these files shrank; lower or remove their oversize entry").toEqual([]);
    });
  }

  for (const { root, cycles: recorded } of FOLDER_CYCLES) {
    test(`${root}: folder cycles only shrink`, () => {
      const treeRoot = TREES.find((t) => root === t.root || root.startsWith(t.root + "/"));
      if (!treeRoot) throw new Error(`${root} is not inside a measured tree`);
      const sub = relative(join(REPO, treeRoot.root), join(REPO, root));
      const found = cycles(folderGraph(importGraph(join(REPO, treeRoot.root), treeRoot.aliases), sub));
      // Every folder now in a cycle was already in one, in a cycle that has not merged with another.
      const grown = found.filter((c) => !recorded.some((r) => c.every((m) => r.includes(m))));
      expect(grown, "a folder cycle grew or a new one appeared").toEqual([]);
      expect(found, "a folder cycle shrank; record the smaller one to lock it in").toEqual(recorded);
    });
  }

  test("apps/hub/src: every top-level entry has a place in the layer order", () => {
    const entries = [...folderGraph(importGraph(join(REPO, "apps/hub/src"))).keys()].toSorted();
    expect(entries, "place a new folder or top-level file in HUB_LAYERS, or drop a gone one").toEqual(
      HUB_LAYERS.toSorted(),
    );
  });

  test("apps/hub/src: imports between top-level entries point down the layer order", () => {
    const rank = new Map(HUB_LAYERS.map((name, i) => [name, i] as const));
    const up: string[] = [];
    for (const [from, targets] of folderGraph(importGraph(join(REPO, "apps/hub/src"))))
      for (const to of targets)
        if ((rank.get(to) ?? -1) > (rank.get(from) ?? -1)) up.push(`${from} -> ${to}`);
    const added = up.filter((e) => !KNOWN_BACK_EDGES.includes(e));
    expect(added, "these imports point up the layer order (see HUB_LAYERS for how to fix one)").toEqual([]);
    const gone = KNOWN_BACK_EDGES.filter((e) => !up.includes(e));
    expect(gone, "these back-edges are gone; remove them from KNOWN_BACK_EDGES").toEqual([]);
  });

  test("the cycle finder sees a cycle and nothing else", () => {
    const graph = new Map([
      ["a.ts", ["b.ts"]],
      ["b.ts", ["c.ts"]],
      ["c.ts", ["a.ts"]],
      ["d.ts", ["a.ts"]],
    ]);
    expect(cycles(graph)).toEqual([["a.ts", "b.ts", "c.ts"]]);
  });

  test("the folder graph joins files by their folder under the given root", () => {
    const graph = new Map([
      ["db/x.ts", ["services/y.ts"]],
      ["services/y.ts", ["db/x.ts", "services/z/w.ts"]],
      ["services/z/w.ts", ["services/y.ts"]],
      ["routes.ts", ["db/x.ts"]],
    ]);
    expect(cycles(folderGraph(graph))).toEqual([["db", "services"]]);
    expect(cycles(folderGraph(graph, "services"))).toEqual([["y", "z"]]);
  });
});
