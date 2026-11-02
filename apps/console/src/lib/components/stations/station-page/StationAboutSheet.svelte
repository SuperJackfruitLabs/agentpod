<script lang="ts">
  /**
   * The phone's rail: everything the context column holds, plus Restart and Stop (which also
   * stay in the header). Both still go through the page's confirm.
   */
  import type { Snippet } from "svelte";
  import type { StationRow } from "$lib/api/client";
  import { Button } from "$lib/components/ui/button";
  import * as Sheet from "$lib/components/ui/sheet";

  type Lifecycle = "stop" | "restart";

  interface Props {
    open: boolean;
    station: StationRow;
    canLifecycle: boolean;
    actionInFlight: Lifecycle | null;
    onAsk: (action: Lifecycle) => void;
    /** The context rail, the same snippet the shell renders on a wide screen. */
    rail: Snippet;
  }

  let { open = $bindable(), station, canLifecycle, actionInFlight, onAsk, rail }: Props = $props();
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="bottom" class="ap-about" data-testid="station-about">
    <Sheet.Title class="ap-about__title">About {station.displayName}</Sheet.Title>
    <Sheet.Description class="sr-only">Identity, placement, voice and who may dispatch this agent</Sheet.Description>
    <div class="ap-about__body">
      {@render rail()}
      {#if canLifecycle}
        <div class="ap-about__actions">
          <Button variant="outline" disabled={actionInFlight !== null} onclick={() => onAsk("restart")}>Restart</Button>
          <Button variant="destructive" disabled={actionInFlight !== null} onclick={() => onAsk("stop")}>Stop</Button>
        </div>
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>
