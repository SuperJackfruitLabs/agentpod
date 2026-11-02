<script lang="ts">
  /**
   * The station page's header: the agent's face, live state and name, where it runs and when it
   * last spoke, Restart and Stop (both through the page's confirm), the phone's About button, a
   * lifecycle error, and the tab strip (`children`).
   */
  import type { Snippet } from "svelte";
  import type { StationRow } from "$lib/api/client";
  import StateDot from "$lib/components/shell/StateDot.svelte";
  import type { StateInfo } from "$lib/fleet/state";
  import { Button } from "$lib/components/ui/button";
  import IdCardIcon from "@lucide/svelte/icons/id-card";
  import { Face } from "@superjackfruit/vibekit";

  type Lifecycle = "stop" | "restart";

  interface Props {
    station: StationRow | null;
    stationId: string;
    nodeId: string;
    stationLoad: "loading" | "loaded" | "notFound" | "error";
    liveState: StateInfo;
    nodeName: string;
    lastSpoke: string;
    canLifecycle: boolean;
    actionInFlight: Lifecycle | null;
    actionError: string | null;
    phone: boolean;
    onAsk: (action: Lifecycle) => void;
    onAbout: () => void;
    children?: Snippet;
  }

  let {
    station,
    stationId,
    nodeId,
    stationLoad,
    liveState,
    nodeName,
    lastSpoke,
    canLifecycle,
    actionInFlight,
    actionError,
    phone,
    onAsk,
    onAbout,
    children,
  }: Props = $props();
</script>

<!-- `relative`: StateDot's sr-only word is position:absolute, and with no
     positioned ancestor inside the stage's scroller it escapes every
     overflow-hidden between here and the document. -->
<header class="ap-st-head relative shrink-0 border-b border-border bg-background" data-testid="station-header">
  <div class="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-3 sm:px-6">
    <div class="min-w-0 flex-1">
      <div class="ap-st-title flex min-w-0 items-center gap-2">
        <span aria-hidden="true" class="ap-st-face"
          ><Face id={stationId} label={station?.displayName ?? stationId} mood={liveState.id === "running" ? "working" : "resting"} size={44} /></span
        >
        <StateDot state={liveState} />
        <h1
          class="ap-st-name truncate font-mono text-[21px] leading-tight font-medium"
          data-testid="station-handle"
          title={station?.displayName ?? stationId}
        >
          {station?.displayName ??
            (stationLoad === "loaded" || stationLoad === "loading" ? stationId : "Agent")}
        </h1>
      </div>
      <p class="ap-st-sub mt-1 truncate text-sm text-muted-foreground" data-testid="station-summary">
        {#if station}
          <!-- Mono for the machine-issued halves only; the joins are prose. -->
          <span class="font-mono" data-testid="station-key">{station.stationKey}</span>
          on <a class="font-mono underline-offset-2 hover:underline" href="/nodes/{nodeId}"
            >{nodeName}</a
          >
          · {liveState.label} · last spoke {lastSpoke === "—" ? "unknown" : lastSpoke}
        {:else if stationLoad === "loading"}
          Loading this agent…
        {/if}
      </p>
    </div>

    {#if canLifecycle}
      <div class="ap-st-actions flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={actionInFlight !== null}
          onclick={() => onAsk("restart")}
        >
          {actionInFlight === "restart" ? "Restarting…" : "Restart"}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={actionInFlight !== null}
          onclick={() => onAsk("stop")}
        >
          {actionInFlight === "stop" ? "Stopping…" : "Stop"}
        </Button>
      </div>
    {/if}
  </div>

  {#if phone && station}
    <div class="px-4 pb-3">
      <button type="button" class="ap-st-about" onclick={onAbout}>
        <IdCardIcon class="size-4" aria-hidden="true" />About {station.displayName}
      </button>
    </div>
  {/if}

  {#if actionError}
    <p class="px-4 pb-2 text-sm text-status-error sm:px-6" role="alert">{actionError}</p>
  {/if}

  {@render children?.()}
</header>
