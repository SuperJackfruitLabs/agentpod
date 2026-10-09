<script lang="ts">
  import type { McpProxyStationView } from "@agentpod/contract";
  import * as api from "$lib/api/mcp-proxy";

  // Read-only: whether this station's sessions get the hub's and Superlibrary's MCP tools through
  // its node's loopback proxy. Changing it is `fleet mcp-proxy enable|disable`, which is audited.
  let { stationId }: { stationId: string } = $props();
  let view = $state<McpProxyStationView | null>(null);
  let error = $state<string | null>(null);
  let epoch = 0;

  $effect(() => {
    const id = stationId;
    const ticket = ++epoch;
    view = null;
    error = null;
    void api
      .getStationMcpProxy(id)
      .then((v) => { if (ticket === epoch) view = v; })
      .catch((e) => { if (ticket === epoch) error = e instanceof Error ? e.message : "Could not read the MCP proxy"; });
    return () => { epoch++; };
  });

  const labels: Record<McpProxyStationView["state"], string> = {
    on: "On",
    off: "Off",
    drifted: "Drifted",
    ineffective: "Served, but unusable",
    unknown: "Unknown",
  };
  const explain = $derived.by(() => {
    if (!view) return "";
    switch (view.state) {
      case "on":
        return "Sessions on this station get the hub's and Superlibrary's MCP tools through the node's loopback proxy.";
      case "off":
        return view.eligible
          ? "Sessions on this station get no proxied MCP tools."
          : `${view.harness} takes no HTTP MCP servers in a session, so the proxy cannot serve it.`;
      case "drifted":
        return view.declared
          ? "Declared on, but the node does not serve it."
          : "Declared off, but the node still serves it.";
      case "ineffective":
        return `The node serves it, but ${view.harness} takes no HTTP MCP servers, so no session gets the tools.`;
      case "unknown":
        return "The node could not be asked — it is offline, or too old to say.";
    }
  });
</script>

<section class="space-y-1 border-b p-4" aria-labelledby="mcp-proxy-heading">
  <div class="flex items-center gap-2">
    <h2 id="mcp-proxy-heading" class="font-semibold">Library tools (MCP proxy)</h2>
    {#if view}
      <span data-testid="mcp-proxy-state" class="rounded border px-1.5 py-0.5 text-xs">{labels[view.state]}</span>
    {/if}
  </div>
  {#if error}
    <p class="text-sm text-muted-foreground">{error}</p>
  {:else if view}
    <p class="text-sm text-muted-foreground">{explain}</p>
    <p class="text-xs text-muted-foreground">Change it with <code>fleet mcp-proxy enable|disable {view.stationId}</code>.</p>
  {:else}
    <p class="text-sm text-muted-foreground">Asking the node…</p>
  {/if}
</section>
