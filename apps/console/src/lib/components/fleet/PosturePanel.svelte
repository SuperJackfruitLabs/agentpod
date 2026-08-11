<script lang="ts">
  import { nodePosture } from "$lib/api/client";
  import type { PostureReportResult } from "$lib/api/client";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";

  interface Props {
    nodeId: string;
  }

  let { nodeId }: Props = $props();

  // ─── State ────────────────────────────────────────────────────────────────────

  let report = $state<PostureReportResult | null>(null);
  let scanning = $state(false);
  let scanError = $state<string | null>(null);

  // ─── Derived ──────────────────────────────────────────────────────────────────

  const failures = $derived(report?.findings.filter((f) => f.status === "fail") ?? []);
  /** Kept apart from passes on purpose: a check that could not run is not a
   *  pass, and folding the two together is how a scanner stops being trusted. */
  const unknowns = $derived(report?.findings.filter((f) => f.status === "unknown") ?? []);
  const passes = $derived(report?.findings.filter((f) => f.status === "pass") ?? []);

  const gradeClass = $derived(
    report?.grade === "A"
      ? "text-emerald-600 dark:text-emerald-500"
      : report?.grade === "F"
        ? "text-destructive"
        : "text-amber-600 dark:text-amber-500"
  );

  // ─── Actions ──────────────────────────────────────────────────────────────────

  async function scan() {
    scanning = true;
    scanError = null;
    try {
      report = await nodePosture(nodeId);
    } catch (e) {
      scanError = e instanceof Error ? e.message : "Couldn't scan this machine.";
    } finally {
      scanning = false;
    }
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Posture</Card.Title>
    <Card.Description>
      Credential files and agent listeners on this machine. Nothing is stored —
      this reads the machine as it is right now.
    </Card.Description>
  </Card.Header>

  <Card.Content class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-3">
      <Button variant="outline" size="sm" onclick={scan} disabled={scanning}>
        {scanning ? "Scanning…" : "Scan"}
      </Button>
      {#if report}
        <span class="text-2xl font-bold {gradeClass}">{report.grade}</span>
        <span class="text-muted-foreground text-xs">
          {report.findings.length} checked · {failures.length} failed · {unknowns.length}
          could not be determined
        </span>
      {/if}
    </div>

    {#if scanError}
      <p class="text-destructive text-sm">{scanError}</p>
    {/if}

    {#each failures as f (f.check + (f.path ?? "") + (f.station ?? ""))}
      <div class="border-destructive/40 border-l-2 pl-3">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="destructive">{f.severity}</Badge>
          <span class="text-sm font-medium">{f.title}</span>
          {#if f.station}
            <code class="text-muted-foreground font-mono text-xs">{f.station}</code>
          {:else if f.harness}
            <span class="text-muted-foreground text-xs">{f.harness}</span>
          {/if}
        </div>
        <p class="text-muted-foreground mt-1 text-sm">{f.detail}</p>
        {#if f.remedy}
          <p class="mt-1 font-mono text-xs">fix: {f.remedy}</p>
        {/if}
      </div>
    {/each}

    {#each unknowns as f (f.check + (f.path ?? ""))}
      <div class="border-l-2 border-amber-500/40 pl-3">
        <p class="text-sm font-medium">{f.title}</p>
        <p class="text-muted-foreground mt-1 text-sm">{f.detail}</p>
      </div>
    {/each}

    {#if report && failures.length === 0 && unknowns.length === 0}
      <p class="text-muted-foreground text-sm">
        Nothing exposed, nothing world-readable. {passes.length} check(s) passed.
      </p>
    {/if}
  </Card.Content>
</Card.Root>
