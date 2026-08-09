<script lang="ts">
  /**
   * ToolCallCard — one agent tool invocation in the transcript.
   *
   * Header (status dot · mono title · toolKind suffix) is always visible and
   * doubles as the collapsible trigger when there is content to show. The
   * body is open by default only while the call is in_progress, auto-collapses
   * exactly once on the in_progress→done edge (same edge pattern as
   * Reasoning.svelte) and manual toggles are never fought between edges.
   *
   * Tool status → status token mapping lives HERE (tokenFor doesn't know the
   * ACP vocab): pending/in_progress → starting (pulsing while in_progress),
   * completed → running, failed → error.
   */
  import { ChevronDown } from "@lucide/svelte";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Status } from "$lib/components/ui/status";
  import DiffBlock from "./DiffBlock.svelte";
  import type { ChatItem, ToolStatus } from "./transcript";

  interface Props {
    item: Extract<ChatItem, { kind: "tool" }>;
  }

  let { item }: Props = $props();

  const STATUS_TOKEN: Record<ToolStatus, string> = {
    pending: "starting",
    in_progress: "starting",
    completed: "running",
    failed: "error",
  };

  const inProgress = $derived(item.status === "in_progress");
  const hasBody = $derived(item.content.length > 0 || item.locations.length > 0);

  // Both initializers deliberately capture the INITIAL in_progress value:
  // `open` is user-owned state seeded once, `wasInProgress` is the previous
  // value for edge detection (plain let, not $state — it must never retrigger
  // the effect itself).
  // svelte-ignore state_referenced_locally
  let open = $state(inProgress);
  // svelte-ignore state_referenced_locally
  let wasInProgress = inProgress;

  // Act on EDGES only: finishing (true→false) collapses once, restarting
  // (false→true) re-opens. Between edges `open` belongs to the user.
  $effect(() => {
    if (wasInProgress !== inProgress) open = inProgress;
    wasInProgress = inProgress;
  });
</script>

{#snippet header()}
  <Status
    form="dot"
    status={STATUS_TOKEN[item.status]}
    animate={inProgress}
    label={item.status}
  />
  <span class="min-w-0 truncate font-mono text-sm">{item.title}</span>
  {#if item.toolKind}
    <span class="t-label shrink-0">{item.toolKind}</span>
  {/if}
{/snippet}

{#if hasBody}
  <Collapsible.Root bind:open>
    <Collapsible.Trigger
      class="group flex w-full items-center gap-2 rounded-sm py-0.5 text-left hover:text-foreground"
    >
      {@render header()}
      <ChevronDown
        class="size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none group-data-[state=closed]:-rotate-90"
        aria-hidden="true"
      />
    </Collapsible.Trigger>
    <Collapsible.Content>
      <div class="mt-1 space-y-2 border-l-2 border-border pl-3">
        {#each item.content as block, i (i)}
          {#if block.type === "text"}
            <pre
              data-testid="tool-text"
              class="t-body m-0 whitespace-pre-wrap break-words text-muted-foreground"
            >{block.text}</pre>
          {:else if block.type === "diff"}
            <DiffBlock path={block.path} oldText={block.oldText} newText={block.newText} />
          {/if}
        {/each}
        {#if item.locations.length > 0}
          <ul data-testid="tool-locations" class="space-y-0.5">
            {#each item.locations as loc (loc)}
              <li class="t-label font-mono">{loc}</li>
            {/each}
          </ul>
        {/if}
      </div>
    </Collapsible.Content>
  </Collapsible.Root>
{:else}
  <div class="flex items-center gap-2 py-0.5">
    {@render header()}
  </div>
{/if}
