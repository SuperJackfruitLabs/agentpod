import { SalaamManagedMcpFeatures } from "@agentpod/contract";

/** The node's admitted server echo and the actual adapter capability must agree. */
export function assertSalaamManagedMcp(
  initialized: unknown,
  expected: string[],
): void {
  if (!expected.length) return;
  const value = initialized as {
    _meta?: Record<string, unknown>;
    agentCapabilities?: { mcpCapabilities?: { http?: boolean } };
  };
  const parsed = SalaamManagedMcpFeatures.safeParse(
    value?._meta?.["salaam.dev/managedMcp"],
  );
  if (
    !parsed.success ||
    value.agentCapabilities?.mcpCapabilities?.http !== true ||
    [...parsed.data.servers].sort().join() !== [...expected].sort().join()
  )
    throw Error(
      "Salaam managed MCP capability differs from the node's admitted servers; upgrade or review the host profile",
    );
}
