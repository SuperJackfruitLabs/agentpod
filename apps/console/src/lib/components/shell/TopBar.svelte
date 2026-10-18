<script lang="ts">
  /**
   * TopBar — 46px of chrome, and one load-bearing fact.
   *
   * The fact is the hub pill. `hubUrl()` falls back to http://localhost:3001,
   * so a console pointed at nothing has always looked identical to a working
   * one. The host is now permanently on screen with a reachability dot, which
   * is also why the old `hub-unreachable-banner` is gone: two places saying
   * the hub is unreachable is the same scattered-state defect in miniature.
   */
  import { connection } from "$lib/stores/connection.svelte";
  import { commandPalette } from "$lib/stores/command-palette.svelte";
  import { STATE } from "$lib/fleet/state";
  import StateDot from "./StateDot.svelte";
  import AccountMenu from "./AccountMenu.svelte";
  import Mark from "$lib/components/brand/Mark.svelte";
  import PanelLeft from "@lucide/svelte/icons/panel-left";
  import Search from "@lucide/svelte/icons/search";

  interface Props {
    /** Fires the ≤900px one-column view switch. Desktop never calls it. */
    onToggleRoster?: () => void;
  }

  let { onToggleRoster }: Props = $props();

  /**
   * Host only — the scheme and path are noise next to "which machine".
   * Guarded because apiUrl is null before initConnection and can be whatever
   * a previous session left in localStorage; a malformed value is shown raw,
   * since "the hub URL is garbage" is exactly what the operator needs to see.
   */
  const hubHost = $derived.by(() => {
    const url = connection.apiUrl;
    if (!url) return "No hub";
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  });

  /**
   * `reachable` alone would lie: it starts optimistically true and the probe
   * only runs while connected, so a hub that failed its boot handshake would
   * show a running dot next to a console that is talking to nothing — the
   * exact deceit this pill exists to end. No hub configured at all is
   * `unknown`, not `error`: nothing is broken, nothing is set.
   */
  const hubState = $derived.by(() => {
    if (!connection.apiUrl) return STATE.unknown;
    if (!connection.isConnected) return STATE.error;
    return connection.reachable ? STATE.running : STATE.error;
  });

  /**
   * 32px for a mouse at desktop widths; 44px — a fingertip — below 901px and
   * on any coarse pointer (an iPad in landscape is wide but still a finger).
   * The audit measured these at 32×32 on a 390px phone.
   */
  const touch = "max-[900px]:size-11 pointer-coarse:size-11";

  const controlClass =
    "inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground";
</script>

<header data-testid="top-bar" class="ap-top flex min-w-0 items-center">
  <!-- Only reachable in the one-column layout, where roster and stage are two
       views rather than two columns. -->
  <button
    type="button"
    data-testid="roster-toggle"
    class="ap-top__icon {controlClass} size-8 {touch} shrink-0 min-[901px]:hidden"
    aria-label="Show the roster"
    onclick={() => onToggleRoster?.()}
  >
    <PanelLeft class="size-5" aria-hidden="true" />
  </button>

  <!-- The mark and the name as agentpod.dev and the docs set them: the name in
       plain text, the colour on the mark. -->
  <a
    href="/"
    data-testid="wordmark"
    aria-label="AgentPod home"
    class="ap-brand flex shrink-0 items-center max-[900px]:min-h-11 max-[900px]:min-w-11 max-[900px]:justify-center pointer-coarse:min-h-11"
  >
    <span class="ap-brand__mark"><Mark class="size-[20px]" /></span>
    <!-- The name gives way on a phone: the mark still links home, and the hub pill
         (the bar's one load-bearing fact) keeps its room. -->
    <span class="ap-brand__name max-[900px]:hidden">AgentPod</span>
  </a>

  <a
    href="/settings"
    data-testid="hub-pill"
    title={connection.apiUrl ?? "No hub configured"}
    class="ap-hub flex min-w-0 items-center max-[900px]:min-h-11 pointer-coarse:min-h-11"
  >
    <StateDot state={hubState} size="sm" />
    <span
      data-testid="hub-host"
      class="truncate font-mono max-[560px]:max-w-32"
    >{hubHost}</span>
  </a>

  <div class="flex-1"></div>

  <button
    type="button"
    data-testid="palette-cue"
    class="ap-cue min-w-0 pointer-coarse:h-11 max-[900px]:size-11"
    aria-label="Message an agent, or run a command"
    onclick={() => commandPalette.toggle()}
  >
    <Search class="ap-cue__icon shrink-0" aria-hidden="true" />
    <span class="ap-cue__text truncate max-[900px]:hidden">Message an agent, or run a command</span>
    <kbd class="ap-kbd max-[900px]:hidden">⌘K</kbd>
  </button>

  <div data-testid="account-slot" class="shrink-0 max-[900px]:hidden">
    <AccountMenu />
  </div>
</header>
