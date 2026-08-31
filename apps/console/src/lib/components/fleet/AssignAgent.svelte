<script lang="ts">
  /**
   * AssignAgent.svelte
   *
   * Puts an EXISTING principal into a station — the control this slice was
   * missing until now. `AgentCreate.svelte` wires the only path that ever
   * called `assignStationAgent`: minting a brand-new agent and handing it a
   * station in the same click. There was no way to take a principal that
   * already exists — most pointedly, one this same page just unassigned —
   * and put it somewhere. An operator could strand an agent and never get it
   * back without a database client, which is exactly the gap this slice
   * exists to close.
   *
   * Reuses `GET /api/admin/principals` (via `$lib/api/grants`'s
   * `listPrincipals`) rather than a second endpoint — the same list Task 3
   * already loads to know which stations are suspended-not-dispatchable.
   * The page passes in only the agent principals not already occupying a
   * station; picking one already active elsewhere would silently orphan its
   * current station, since the hub's assign endpoint has no opinion about
   * where a principal was before.
   *
   * A suspended principal is still offered rather than filtered out — hiding
   * it would look like it does not exist, when what is actually true is that
   * assigning it is refused. The hub's own 403 is what tells the operator
   * that, surfaced here exactly as AgentCreate.svelte surfaces its refusals,
   * not swallowed into a generic failure.
   */
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import { Button } from "$lib/components/ui/button";
  import { Field } from "$lib/components/ui/field";
  import { Spinner } from "$lib/components/ui/spinner";
  import { assignStationAgent } from "$lib/api/agents";
  import type { PrincipalSummary } from "$lib/api/grants";

  export interface AssignStationTarget {
    id: string;
    displayName: string;
    nodeName?: string;
  }

  interface Props {
    open: boolean;
    station: AssignStationTarget | null;
    /** Agent principals offered — the page decides which ones make sense. */
    candidates: PrincipalSummary[];
    onAssigned: (result: { principal: PrincipalSummary; stationId: string }) => void;
  }

  let { open = $bindable(false), station, candidates, onAssigned }: Props = $props();

  let selectedId = $state<string | null>(null);
  let isAssigning = $state(false);
  let problem = $state<string | null>(null);

  $effect(() => {
    if (open) {
      selectedId = null;
      isAssigning = false;
      problem = null;
    }
  });

  function labelFor(p: PrincipalSummary): string {
    return p.suspendedAt ? `${p.handle} (suspended)` : p.handle;
  }

  function selected(): PrincipalSummary | null {
    return candidates.find((p) => p.id === selectedId) ?? null;
  }

  async function handleSubmit() {
    const principal = selected();
    if (!station || !principal || isAssigning) return;

    isAssigning = true;
    problem = null;
    try {
      await assignStationAgent(station.id, principal.id);
      open = false;
      onAssigned({ principal, stationId: station.id });
    } catch (e) {
      // The hub's own sentence — "principal is suspended", "no such
      // principal" — reaches the operator here rather than being swallowed.
      // A suspended principal stayed selectable on purpose; this is the
      // refusal that makes it not silently offerable.
      problem = (e as Error).message;
    } finally {
      isAssigning = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={(v) => (open = v)}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content showCloseButton={false}>
      <Dialog.Header>
        <Dialog.Title>{station ? `Assign an agent to ${station.displayName}` : "Assign an agent"}</Dialog.Title>
        <Dialog.Description>
          Puts an existing agent principal in this station — it becomes dispatchable as soon as
          this is done.
        </Dialog.Description>
      </Dialog.Header>

      <form
        novalidate
        onsubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
        class="space-y-4 py-2"
      >
        <Field label="Agent to assign" for="assign-agent-principal" error={problem ?? undefined}>
          {#if candidates.length === 0}
            <p class="text-xs text-muted-foreground" data-testid="no-available-agents">
              No unassigned agent principals right now — create a new one instead.
            </p>
          {:else}
            <Select.Root
              type="single"
              value={selectedId ?? ""}
              onValueChange={(v) => (selectedId = v || null)}
            >
              <Select.Trigger class="w-full" id="assign-agent-principal">
                {selectedId ? labelFor(selected()!) : "Choose an agent"}
              </Select.Trigger>
              <Select.Content>
                {#each candidates as p (p.id)}
                  <Select.Item value={p.id}>{labelFor(p)}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          {/if}
        </Field>

        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={() => (open = false)} disabled={isAssigning}>
            Cancel
          </Button>
          <Button type="submit" disabled={isAssigning || !selectedId}>
            {#if isAssigning}<Spinner size="sm" class="text-primary-foreground" />{/if}
            {isAssigning ? "Assigning…" : "Assign"}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
