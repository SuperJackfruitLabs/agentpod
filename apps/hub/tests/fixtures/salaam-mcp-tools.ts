/** Synthetic, immutable catalogs for the local managed-MCP conformance plane. */
export const SALAAM_MCP_FIXTURE_TOOLS = {
  agentpod: [
    {
      name: "agentpod_fixture_status",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ],
  superlibrary: ["library_search", "fixture_mutate"].map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  })),
};
