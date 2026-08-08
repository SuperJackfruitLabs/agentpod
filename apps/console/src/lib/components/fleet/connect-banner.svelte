<script lang="ts">
  /**
   * ConnectBanner
   *
   * Shown on the fleet home when there are zero connected nodes.
   * Repurposed from onboarding-banner.svelte; styled for the fleet/cyber theme.
   * Original (onboarding-banner.svelte) is retained for Task 5.
   */

  import { Button } from "$lib/components/ui/button";

  // ── Props ─────────────────────────────────────────────────────────────────────

  interface Props {
    /** Called when the user clicks "Create enrollment token" */
    onCreateToken: () => void;
  }

  let { onCreateToken }: Props = $props();
</script>

<div
  class="rounded-lg border bg-card p-6"
  data-testid="connect-banner"
>
  <div class="flex items-start gap-5">
    <!-- Icon -->
    <div class="flex-shrink-0">
      <div
        class="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 border border-primary/30"
      >
        <!-- Server / node icon -->
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="text-primary"
        >
          <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
          <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
          <line x1="6" x2="6.01" y1="6" y2="6" />
          <line x1="6" x2="6.01" y1="18" y2="18" />
        </svg>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 min-w-0">
      <h3 class="font-semibold text-base">
        [fleet] Connect your first node
      </h3>
      <p class="mt-2 text-sm text-muted-foreground leading-relaxed">
        No nodes yet. Generate an enrollment token and run the agent on any
        server — it will appear here once it comes online.
      </p>

      <!-- Code hint -->
      <p class="mt-2 text-xs font-mono text-muted-foreground">
        curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh | sudo bash -s -- &lt;hub-url&gt; &lt;token&gt;
      </p>

      <!-- CTA -->
      <div class="mt-4 flex items-center gap-3">
        <Button size="sm" onclick={onCreateToken}>
          Create enrollment token
        </Button>
      </div>
    </div>
  </div>
</div>
