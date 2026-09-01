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
  import { auth } from "$lib/stores/auth.svelte";
  import { commandPalette } from "$lib/stores/command-palette.svelte";
  import { STATE } from "$lib/fleet/state";
  import StateDot from "./StateDot.svelte";
  import PanelLeft from "@lucide/svelte/icons/panel-left";
  import Search from "@lucide/svelte/icons/search";
  import SunMoon from "@lucide/svelte/icons/sun-moon";

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

  const controlClass =
    "inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground";
</script>

<header
  data-testid="top-bar"
  class="flex min-w-0 items-center gap-2 border-b border-border bg-card px-2"
>
  <!-- Only reachable in the one-column layout, where roster and stage are two
       views rather than two columns. -->
  <button
    type="button"
    data-testid="roster-toggle"
    class="{controlClass} size-8 shrink-0 min-[901px]:hidden"
    aria-label="Show the roster"
    onclick={() => onToggleRoster?.()}
  >
    <PanelLeft class="size-4" aria-hidden="true" />
  </button>

  <a
    href="/"
    class="flex shrink-0 items-baseline gap-1.5 rounded px-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
  >
    <span class="text-sm font-semibold tracking-[0.12em] text-foreground">AGENTPOD</span>
    <span
      data-testid="wordmark-suffix"
      class="text-sm tracking-[0.12em] text-muted-foreground max-[900px]:hidden"
    >· MUSTER</span>
  </a>

  <a
    href="/settings"
    data-testid="hub-pill"
    title={connection.apiUrl ?? "No hub configured"}
    class="flex min-w-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
  >
    <StateDot state={hubState} size="sm" />
    <span
      data-testid="hub-host"
      class="truncate font-mono text-xs text-foreground max-[560px]:max-w-24"
    >{hubHost}</span>
  </a>

  <div class="flex-1"></div>

  <button
    type="button"
    data-testid="palette-cue"
    class="{controlClass} h-8 min-w-0 gap-2 border border-border px-2 max-[900px]:size-8 max-[900px]:border-0 max-[900px]:px-0"
    aria-label="Message an agent, or run a command"
    onclick={() => commandPalette.toggle()}
  >
    <Search class="size-3.5 shrink-0" aria-hidden="true" />
    <span class="truncate text-xs max-[900px]:hidden">Message an agent, or run a command</span>
    <kbd
      class="rounded border border-border px-1 font-mono text-[10px] text-muted-foreground max-[900px]:hidden"
    >⌘K</kbd>
  </button>

  <a
    href="/settings"
    data-testid="appearance-link"
    class="{controlClass} size-8 shrink-0"
    aria-label="Appearance"
  >
    <SunMoon class="size-4" aria-hidden="true" />
  </a>

  <div
    data-testid="user-avatar"
    class="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-foreground"
    aria-label="Signed in as {auth.initials}"
  >{auth.initials}</div>
</header>
