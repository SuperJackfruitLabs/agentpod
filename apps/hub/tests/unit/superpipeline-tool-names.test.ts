/**
 * The hub names SuperPipeline's tools in prose too: the agent instructions its own MCP server
 * sends, the link tool's answer, and the bridge's comments on what a harness will call. Every
 * `superpipeline_*` name in them must be a tool in treaty's catalog (`schemas/mcp/
 * superpipeline.v1.json`, phase 3 review focus 2), and the MCP server the bridge hands a harness
 * must carry the catalog's server name, which is what the harness prefixes its tools with. The
 * card prompt itself is checked in `packages/contract/src/card-prompt-tools.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mcpCatalog, unknownTools } from "@superjackfruitlabs/treaty-contracts";
import { loadInstalledBundle } from "@superjackfruitlabs/treaty-contracts/node";

import { agentInstructions } from "../../src/mcp/server";
import { SUPERPIPELINE_MCP_NAME } from "../../src/services/bridge/dispatch-prompt";

const catalog = mcpCatalog(loadInstalledBundle(), "superpipeline.v1");
const toolNamesIn = (text: string): string[] => [...new Set(text.match(/\bsuperpipeline_[a-z_]+\b/g) ?? [])];

/** Hub sources that name SuperPipeline's tools to an agent, or say what a harness will call. */
const SOURCES = ["mcp/server.ts", "mcp/tools.ts", "services/bridge/dispatch-prompt.ts", "services/bridge/dispatch-exits.ts"];

describe("the hub names only tools in SuperPipeline's catalog", () => {
  test("the agent instructions, with and without the link tool", () => {
    for (const linkOffered of [false, true]) {
      expect(unknownTools(catalog, toolNamesIn(agentInstructions(linkOffered)))).toEqual([]);
    }
    expect(toolNamesIn(agentInstructions(true))).toContain("superpipeline_add_reference");
  });

  for (const file of SOURCES) {
    test(file, () => {
      const names = toolNamesIn(readFileSync(join(import.meta.dir, "../../src", file), "utf8"));
      expect(names.length).toBeGreaterThan(0);
      expect(unknownTools(catalog, names)).toEqual([]);
    });
  }

  test("the board's MCP server goes to the harness under the catalog's server name", () =>
    expect(SUPERPIPELINE_MCP_NAME).toBe(catalog.server.name));
});
