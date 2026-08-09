<script lang="ts">
  /**
   * Reasoning — collapsible agent thinking block.
   *
   * Thoughts are PLAIN TEXT (whitespace-pre-wrap), never markdown. Open by
   * default while streaming; auto-collapses exactly once on the streaming
   * true→false edge and re-opens on the false→true edge (fresh segment on a
   * reused instance). Between edges `open` is the user's — manual toggles are
   * never fought by later prop updates.
   */
  import { ChevronDown } from "@lucide/svelte";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Status } from "$lib/components/ui/status";

  interface Props {
    text: string;
    streaming?: boolean;
  }

  let { text, streaming = false }: Props = $props();

  // Both initializers deliberately capture streaming's INITIAL value: `open`
  // is user-owned state seeded once, and `wasStreaming` is the previous value
  // for edge detection (plain let, not $state — it must never retrigger the
  // effect itself).
  // svelte-ignore state_referenced_locally
  let open = $state(streaming);
  // svelte-ignore state_referenced_locally
  let wasStreaming = streaming;

  // Act on EDGES only, never on same-state reruns: finish (true→false)
  // collapses, a fresh streaming segment (false→true) re-opens — the same
  // component instance is reused across reasoning segments, so without the
  // opening edge a second segment would accumulate collapsed and invisible.
  // Between edges, `open` belongs to the user.
  $effect(() => {
    if (wasStreaming !== streaming) open = streaming;
    wasStreaming = streaming;
  });
</script>

<Collapsible.Root bind:open>
  <Collapsible.Trigger
    class="group flex items-center gap-1.5 rounded-sm py-0.5 text-muted-foreground hover:text-foreground"
  >
    <span class="t-label">Thinking</span>
    <ChevronDown
      class="size-3 shrink-0 transition-transform motion-reduce:transition-none group-data-[state=closed]:-rotate-90"
      aria-hidden="true"
    />
    {#if streaming}
      <Status form="dot" status="starting" animate label="thinking" />
    {/if}
  </Collapsible.Trigger>
  <Collapsible.Content>
    <div
      data-testid="reasoning-content"
      class="t-body mt-1 border-l-2 border-border pl-3 whitespace-pre-wrap text-muted-foreground"
    >
      {text}
    </div>
  </Collapsible.Content>
</Collapsible.Root>
