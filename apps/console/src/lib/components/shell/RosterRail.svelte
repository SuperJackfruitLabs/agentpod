<script lang="ts">
  /**
   * RosterRail — the fleet IS the navigation.
   *
   * One row per agent, always on screen, instead of five resource pages
   * named after database tables. The 3px ribbon down each row's left edge
   * is the point: stacked, the column reads as a vertical barcode of fleet
   * health you take in without reading a word.
   *
   * It reads the shared `fleet` store directly rather than taking agents as
   * a prop. The shell already holds the one poll reference for the whole
   * console (AppShell's onMount), so the rail must never start its own —
   * and threading three slices of the same snapshot through props would buy
   * nothing but a wider component signature.
   */
  import type { FleetAgent, NodeSummary } from "@agentpod/contract";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { STATE, STATE_ORDER, stationState, type StateId } from "$lib/fleet/state";
  import { fleet } from "$lib/stores/fleet.svelte";
  import { cn } from "$lib/utils";
  import StateDot, { STATE_BG_CLASS } from "./StateDot.svelte";

  type Grouping = "node" | "state" | "name";

  /** The button cycles in this order; the label is what it currently is. */
  const GROUPINGS: Grouping[] = ["node", "state", "name"];
  const GROUPING_LABEL: Record<Grouping, string> = {
    node: "by node",
    state: "by state",
    name: "by name",
  };

  let query = $state("");
  let grouping = $state<Grouping>("node");

  /** The scroller, so j/k can pull the new selection into view. */
  let listEl = $state<HTMLElement | null>(null);

  const nodesById = $derived(new Map(fleet.nodes.map((n: NodeSummary) => [n.id, n])));

  function href(agent: FleetAgent): string {
    return `/nodes/${agent.nodeId}/stations/${agent.stationId}`;
  }

  /**
   * Everything the filter box matches, lowercased into one haystack.
   *
   * The brief asks for the agent's purpose. FleetAgent carries none — no
   * purpose field exists on a station in the contract at all — so this
   * matches the NODE's purpose, which is the default an agent adopted there
   * inherits. Recorded as a gap in the task report; no hub change was made.
   */
  function haystack(agent: FleetAgent): string {
    const node = nodesById.get(agent.nodeId);
    return [
      agent.agentName,
      agent.nodeName,
      agent.harness,
      agent.stationId,
      node?.purpose ?? "",
      agent.status,
      stationState(agent.status).label,
    ]
      .join(" ")
      .toLowerCase();
  }

  const visible = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q === "" ? fleet.agents : fleet.agents.filter((a) => haystack(a).includes(q));
  });

  interface Group {
    key: string;
    label: string;
    agents: FleetAgent[];
  }

  const byName = (a: FleetAgent, b: FleetAgent) => a.agentName.localeCompare(b.agentName);

  const groups = $derived.by<Group[]>(() => {
    const rows = [...visible].sort(byName);

    if (grouping === "state") {
      // Worst-first (STATE_ORDER), and only states actually present — an
      // empty "Sleeping" header would be noise in a 272px column.
      return STATE_ORDER.map((id: StateId) => ({
        key: id,
        label: STATE[id].label,
        agents: rows.filter((a) => stationState(a.status).id === id),
      })).filter((g) => g.agents.length > 0);
    }

    if (grouping === "name") {
      const letters = new Map<string, FleetAgent[]>();
      for (const a of rows) {
        // Anything that isn't a letter files under "#" rather than minting a
        // header per punctuation mark.
        const first = a.agentName.charAt(0).toUpperCase();
        const letter = /[A-Z]/.test(first) ? first : "#";
        const bucket = letters.get(letter);
        if (bucket) bucket.push(a);
        else letters.set(letter, [a]);
      }
      return [...letters.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([letter, agents]) => ({ key: letter, label: letter, agents }));
    }

    const nodes = new Map<string, FleetAgent[]>();
    for (const a of rows) {
      const bucket = nodes.get(a.nodeId);
      if (bucket) bucket.push(a);
      else nodes.set(a.nodeId, [a]);
    }
    return [...nodes.entries()]
      .map(([nodeId, agents]) => ({ key: nodeId, label: agents[0].nodeName, agents }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  /** The visible order, flattened — what j/k walk. */
  const flat = $derived(groups.flatMap((g) => g.agents));

  /**
   * Selection is derived from the URL, never held here, so a deep link into
   * a station and a click on its row light up the same row.
   */
  const currentPath = $derived(page.url.pathname);

  /**
   * What the second column says.
   *
   * Two things were tried here first and both said more than the data knows,
   * which is the exact defect this redesign exists to remove:
   *
   * - A flag keyed on `workspacePath === null`, labelled "Unoccupied". A
   *   station can perfectly well hold an agent and have no workspace set up;
   *   the two are different facts. Naming one after the other is how Overview
   *   came to report "5 stopped" for four stopped and one unknown. The real
   *   signal is a station's `principalId`, which arrives with the attention
   *   lane's `unoccupied` rule — the flag comes back then, meaning what it says.
   *
   * - "Last spoke", taken from the node's `lastSeenAt` because a FleetAgent
   *   carries no timestamp. It is node-granular, so grouped by node — the
   *   default — every row in a group repeated one identical value, dressed up
   *   as per-agent precision.
   *
   * So it carries the field that actually varies within the current grouping:
   * inside a node the harnesses differ, and everywhere else the node does.
   */
  function aside(agent: FleetAgent): string {
    return grouping === "node" ? agent.harness : agent.nodeName;
  }

  function cycleGrouping() {
    grouping = GROUPINGS[(GROUPINGS.indexOf(grouping) + 1) % GROUPINGS.length];
  }

  function select(agent: FleetAgent) {
    void goto(href(agent));
    // Looked up rather than held in a per-row ref map: bind:this into a plain
    // object is a non-reactive binding (Svelte warns), and a keypress can
    // afford one walk of a rail that is at most a few hundred rows.
    const row = [...(listEl?.querySelectorAll<HTMLElement>("[data-station]") ?? [])].find(
      (el) => el.dataset.station === agent.stationId,
    );
    // block:"nearest" so walking down a long roster nudges rather than jumps.
    // Optional call: jsdom does not implement scrollIntoView.
    row?.scrollIntoView?.({ block: "nearest" });
  }

  /**
   * j/k/Escape are registered on the window, not on the rail, so they work
   * wherever focus is — the rail is navigation for the whole console, and
   * requiring a click into it first would defeat that.
   *
   * The target check is load-bearing: without it, typing "j" in the filter
   * box below (or in any input on the stage) navigates the roster.
   */
  function onKeydown(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
    }

    if (event.key === "Escape") {
      if (flat.some((a) => href(a) === currentPath)) {
        event.preventDefault();
        void goto("/");
      }
      return;
    }

    if (event.key !== "j" && event.key !== "k") return;
    if (flat.length === 0) return;
    event.preventDefault();

    const index = flat.findIndex((a) => href(a) === currentPath);
    if (index === -1) {
      // Nothing selected: j starts at the top of the fleet, k at the bottom.
      select(event.key === "j" ? flat[0] : flat[flat.length - 1]);
      return;
    }
    const next = event.key === "j" ? Math.min(index + 1, flat.length - 1) : Math.max(index - 1, 0);
    select(flat[next]);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div data-testid="roster" class="flex min-h-0 min-w-0 flex-col overflow-hidden">
  <div class="flex shrink-0 flex-col gap-1.5 border-b border-border px-2 py-2">
    <input
      data-testid="roster-filter"
      type="search"
      bind:value={query}
      placeholder="Filter the fleet"
      aria-label="Filter the fleet"
      class="h-7 w-full rounded border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-2 focus-visible:outline-foreground"
    />
    <div class="flex items-center justify-between gap-2">
      <span
        data-testid="roster-count"
        class="text-[11px] tabular-nums tracking-[0.14em] text-muted-foreground"
        aria-live="polite"
      >
        {query.trim() === ""
          ? `${fleet.agents.length} AGENT${fleet.agents.length === 1 ? "" : "S"}`
          : `${visible.length} of ${fleet.agents.length}`}
      </span>
      <button
        data-testid="roster-grouping"
        type="button"
        onclick={cycleGrouping}
        aria-label={`Grouped ${GROUPING_LABEL[grouping]}. Change grouping.`}
        class="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-2 focus-visible:outline-foreground"
      >{GROUPING_LABEL[grouping]}</button>
    </div>
  </div>

  <!-- The rail's own scroller: min-h-0 so it shrinks inside the shell's
       capped grid instead of pushing "Where they run" off the bottom. -->
  <div bind:this={listEl} data-testid="roster-list" class="min-h-0 min-w-0 flex-1 overflow-y-auto">
    {#each groups as group (group.key)}
      <h2
        data-testid="roster-group"
        class="sticky top-0 z-10 flex items-baseline justify-between gap-2 border-b border-border bg-card px-2 py-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
      >
        <span class="truncate">{group.label}</span>
        <span class="shrink-0 tabular-nums">{group.agents.length}</span>
      </h2>
      {#each group.agents as agent (agent.stationId)}
        {@const state = stationState(agent.status)}
        {@const isCurrent = href(agent) === currentPath}
        <!--
          `relative` is load-bearing, not styling. StateDot's sr-only label is
          position:absolute; with no positioned ancestor its containing block
          is the initial one, so it escapes every overflow:hidden above it and
          adds its static x-position to the DOCUMENT's scroll width — that is
          how a full attention lane widened the document by 328px in task 6,
          and this column holds one dot per agent.
        -->
        <a
          data-testid="roster-row"
          data-station={agent.stationId}
          href={href(agent)}
          aria-current={isCurrent ? "page" : undefined}
          title={`${agent.agentName} on ${agent.nodeName} — ${state.label}`}
          class={cn(
            "relative grid h-[34px] grid-cols-[3px_12px_1fr_auto] items-center transition-colors hover:bg-muted focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-foreground",
            isCurrent && "bg-muted",
          )}
        >
          <span
            data-testid="roster-ribbon"
            aria-hidden="true"
            class={cn("h-full self-stretch", STATE_BG_CLASS[state.token])}
          ></span>
          <span class="flex items-center justify-center">
            <StateDot {state} size="sm" />
          </span>
          <span class="min-w-0 truncate px-2 font-mono text-xs text-foreground">{agent.agentName}</span>
          <span
            data-testid="roster-aside"
            class="truncate pr-2 font-mono text-[11px] text-muted-foreground"
          >{aside(agent)}</span>
        </a>
      {/each}
    {/each}

    {#if flat.length === 0}
      <p data-testid="roster-empty" class="px-2 py-3 text-xs text-muted-foreground">
        {query.trim() === ""
          ? "No agents yet. Adopt one on a node to see it here."
          : `No agent matches “${query.trim()}”.`}
      </p>
    {/if}
  </div>

  <div class="shrink-0 border-t border-border px-2 py-2">
    <p class="pb-1 text-[11px] tracking-[0.14em] text-muted-foreground">WHERE THEY RUN</p>
    <a
      data-testid="roster-nodes-link"
      href="/nodes"
      class="flex items-center justify-between rounded px-1 py-1 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-2 focus-visible:outline-foreground"
    >
      <span>Nodes</span>
      <span class="tabular-nums text-muted-foreground">{fleet.nodes.length}</span>
    </a>
    <a
      data-testid="roster-runtimes-link"
      href="/runtimes"
      class="flex items-center justify-between rounded px-1 py-1 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-2 focus-visible:outline-foreground"
    >
      <span>Runtimes</span>
      <span class="tabular-nums text-muted-foreground">{fleet.runtimes.length}</span>
    </a>
  </div>
</div>
