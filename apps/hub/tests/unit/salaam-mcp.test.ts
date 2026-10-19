import { expect, test } from "bun:test";
import { assertSalaamManagedMcp } from "../../src/services/salaam-mcp";

test("Salaam proxy claims require matching actual adapter capabilities", () => {
  const valid = {
    _meta: {
      "salaam.dev/managedMcp": {
        version: 1,
        servers: ["agentpod", "superlibrary"],
      },
    },
    agentCapabilities: { mcpCapabilities: { http: true } },
  };
  expect(() =>
    assertSalaamManagedMcp(valid, ["superlibrary", "agentpod"]),
  ).not.toThrow();
  expect(() => assertSalaamManagedMcp({}, [])).not.toThrow();
  for (const value of [
    {},
    { ...valid, agentCapabilities: { mcpCapabilities: { http: false } } },
    {
      ...valid,
      _meta: {
        "salaam.dev/managedMcp": {
          version: 2,
          servers: ["agentpod", "superlibrary"],
        },
      },
    },
    {
      ...valid,
      _meta: { "salaam.dev/managedMcp": { version: 1, servers: ["agentpod"] } },
    },
  ])
    expect(() =>
      assertSalaamManagedMcp(value, ["agentpod", "superlibrary"]),
    ).toThrow();
});
