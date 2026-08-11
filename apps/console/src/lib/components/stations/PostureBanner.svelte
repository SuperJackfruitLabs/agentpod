<script lang="ts">
  import { nodePosture } from "$lib/api/client";
  import type { PostureFindingRow } from "$lib/api/client";

  interface Props {
    nodeId: string;
    stationKey: string;
  }

  let { nodeId, stationKey }: Props = $props();

  let mine = $state<PostureFindingRow[]>([]);

  /**
   * Only findings that name THIS station.
   *
   * Harness-level findings stay on the node page: this Mac has twenty-odd
   * claude-code stations sharing one credential file, and repeating that one
   * fact on every station page turns a real problem into wallpaper.
   */
  async function load() {
    try {
      const report = await nodePosture(nodeId);
      mine = report.findings.filter((f) => f.status === "fail" && f.station === stationKey);
    } catch {
      // A passive banner on a page opened for something else. A failed
      // background scan must not put an error in front of someone who did not
      // ask for one — the node page's Scan button is where errors belong.
      mine = [];
    }
  }

  $effect(() => {
    void stationKey;
    load();
  });
</script>

{#if mine.length > 0}
  <div class="border-destructive/40 bg-destructive/5 rounded-md border p-3">
    {#each mine as f (f.check + (f.path ?? ""))}
      <p class="text-sm font-medium">{f.title}</p>
      <p class="text-muted-foreground mt-1 text-sm">{f.detail}</p>
      {#if f.remedy}
        <p class="mt-1 font-mono text-xs">fix: {f.remedy}</p>
      {/if}
    {/each}
    <a class="mt-2 inline-block text-xs underline" href="/nodes/{nodeId}">
      See this machine's full posture
    </a>
  </div>
{/if}
