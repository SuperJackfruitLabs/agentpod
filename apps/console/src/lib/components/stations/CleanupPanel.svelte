<script lang="ts">
  import { cleanupPlan, cleanupApply } from "$lib/api/client";
  import type { CleanupItem } from "$lib/api/client";
  import TypeToConfirmDialog from "$lib/components/ui/TypeToConfirmDialog.svelte";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Empty } from "$lib/components/ui/empty";

  interface Props {
    stationId: string;
  }

  let { stationId }: Props = $props();

  // ─── State ────────────────────────────────────────────────────────────────────

  let items = $state<CleanupItem[]>([]);
  let totalBytes = $state(0);
  let scanned = $state(false);
  let scanning = $state(false);
  let scanError = $state<string | null>(null);

  /** Set of selected paths */
  let selected = $state<Set<string>>(new Set());

  let applying = $state(false);
  let applyError = $state<string | null>(null);
  let removedBytes = $state<number | null>(null);

  let dialogOpen = $state(false);

  // ─── Derived ──────────────────────────────────────────────────────────────────

  const selectedPaths = $derived(Array.from(selected));
  const selectedTotal = $derived(
    items.filter((i) => selected.has(i.path)).reduce((acc, i) => acc + i.size, 0)
  );
  const applyDisabled = $derived(selected.size === 0 || applying || scanning);

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1_073_741_824) return `${(n / 1_048_576).toFixed(1)} MB`;
    return `${(n / 1_073_741_824).toFixed(2)} GB`;
  }

  // ─── Actions ──────────────────────────────────────────────────────────────────

  async function doScan() {
    scanning = true;
    scanError = null;
    removedBytes = null;
    selected = new Set();
    try {
      const plan = await cleanupPlan(stationId);
      items = plan.items;
      totalBytes = plan.totalBytes;
      scanned = true;
    } catch (err) {
      scanError = err instanceof Error ? err.message : "Scan failed";
    } finally {
      scanning = false;
    }
  }

  function handleApplyClick() {
    dialogOpen = true;
  }

  function handleDialogCancel() {
    dialogOpen = false;
  }

  async function handleDialogConfirm() {
    dialogOpen = false;
    applying = true;
    applyError = null;
    try {
      const result = await cleanupApply(stationId, selectedPaths);
      removedBytes = result.removedBytes;
      // Clear state after successful apply
      items = [];
      totalBytes = 0;
      selected = new Set();
      scanned = false;
    } catch (err) {
      applyError = err instanceof Error ? err.message : "Apply failed";
    } finally {
      applying = false;
    }
  }

  function toggleItem(path: string) {
    const next = new Set(selected);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    selected = next;
  }
</script>

<div class="flex flex-col gap-4 p-4">
  <!-- Toolbar: Scan, total bytes, Apply — one row -->
  <div class="flex items-center gap-2">
    <Button size="sm" disabled={scanning} onclick={doScan}>
      {scanning ? "Scanning…" : "Scan"}
    </Button>

    {#if scanned && items.length > 0}
      <Badge variant="secondary" class="font-mono text-xs tabular-nums">
        {formatBytes(totalBytes)}{#if selected.size > 0} · {formatBytes(selectedTotal)} selected{/if}
      </Badge>
    {/if}

    {#if scanned || items.length > 0}
      <Button variant="destructive" size="sm" disabled={applyDisabled} onclick={handleApplyClick}>
        Apply
      </Button>
    {/if}
  </div>

  <!-- Errors -->
  {#if scanError}
    <p class="text-sm text-destructive">{scanError}</p>
  {/if}
  {#if applyError}
    <p class="text-sm text-destructive">{applyError}</p>
  {/if}

  <!-- Freed bytes feedback -->
  {#if removedBytes !== null}
    <p class="text-sm text-status-running">
      Freed {formatBytes(removedBytes)}.
    </p>
  {/if}

  <!-- Plan results -->
  {#if scanned}
    {#if items.length === 0}
      <Empty title="Nothing to clean" />
    {:else}
      <Card.Root class="overflow-hidden border-border/60">
        <ul class="divide-y divide-border/40">
          {#each items as item (item.path)}
            <li
              class="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-muted/40"
            >
              <input
                type="checkbox"
                id="cleanup-{item.path}"
                aria-label={item.path}
                checked={selected.has(item.path)}
                onchange={() => toggleItem(item.path)}
                class="h-4 w-4 shrink-0 cursor-pointer rounded border-border accent-primary"
              />
              <label
                for="cleanup-{item.path}"
                class="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-3"
              >
                <span class="truncate font-mono text-xs text-foreground" title={item.path}>
                  {item.path}
                </span>
                <span class="flex shrink-0 items-center gap-2">
                  <span class="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {item.kind}
                  </span>
                  <span class="font-mono text-xs tabular-nums text-muted-foreground">
                    {formatBytes(item.size)}
                  </span>
                </span>
              </label>
            </li>
          {/each}
        </ul>
      </Card.Root>
    {/if}
  {/if}
</div>

<TypeToConfirmDialog
  open={dialogOpen}
  title="Apply cleanup"
  message="This will permanently remove the selected {selectedPaths.length} item{selectedPaths.length === 1 ? '' : 's'}. Type the station ID below to confirm."
  confirmPhrase={stationId}
  confirmLabel="Confirm"
  onConfirm={handleDialogConfirm}
  onCancel={handleDialogCancel}
/>
