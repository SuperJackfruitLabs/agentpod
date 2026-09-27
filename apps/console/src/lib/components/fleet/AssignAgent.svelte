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
   *
   * **Occupancy is exclusive — fix round.** `routes/agents-admin.ts`'s
   * assign endpoint now vacates a principal's previous station in the same
   * transaction it places it in a new one, which makes offering an
   * ALREADY-occupied agent safe: picking one moves it, it does not leave two
   * stations claiming it. The page therefore offers every agent principal,
   * not only unoccupied ones — each candidate carries the station it
   * currently occupies, if any, so its option reads "moving an agent" rather
   * than "placing a spare one". The one candidate excluded here, not by the
   * page, is the principal already at THIS station: reassigning it to
   * itself is a real no-op the picker has no business offering.
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
  import { toast } from "svelte-sonner";
  import { assignStationAgent, roomProblem } from "$lib/api/agents";
  import type { PrincipalSummary } from "$lib/api/grants";

  export interface AssignStationTarget {
    id: string;
    displayName: string;
    nodeName?: string;
  }

  /** A candidate agent, and where it currently runs — if anywhere. */
  export interface AssignCandidate {
    principal: PrincipalSummary;
    currentStation: { id: string; displayName: string } | null;
  }

  interface Props {
    open: boolean;
    station: AssignStationTarget | null;
    /** Every agent principal — occupied or not. The page decides nothing
     *  here except which station each one is currently at. */
    candidates: AssignCandidate[];
    onAssigned: (result: { principal: PrincipalSummary; stationId: string }) => void;
  }

  let { open = $bindable(false), station, candidates, onAssigned }: Props = $props();

  let selectedId = $state<string | null>(null);
  let isAssigning = $state(false);
  let problem = $state<string | null>(null);

  // The one filter this component owns, rather than the page: whoever
  // already occupies the TARGET station has nothing to move — offering it
  // would be a picker option whose only effect is a no-op round trip.
  let offered = $derived(candidates.filter((c) => c.currentStation?.id !== station?.id));

  $effect(() => {
    if (open) {
      selectedId = null;
      isAssigning = false;
      problem = null;
    }
  });

  function labelFor(c: AssignCandidate): string {
    const base = c.principal.suspendedAt ? `${c.principal.handle} (suspended)` : c.principal.handle;
    return c.currentStation ? `${base} — moving from ${c.currentStation.displayName}` : base;
  }

  function selected(): AssignCandidate | null {
    return offered.find((c) => c.principal.id === selectedId) ?? null;
  }

  async function handleSubmit() {
    const candidate = selected();
    if (!station || !candidate || isAssigning) return;

    isAssigning = true;
    problem = null;
    try {
      const result = await assignStationAgent(station.id, candidate.principal.id);
      open = false;
      // Assigned, but the homeserver refused it a room. Deliberately not an
      // error toast: the assignment stands, and calling it a failure would
      // send the operator to retry something that already happened. It must
      // still be said — the whole finding this came from is that a silent
      // gap looked exactly like success.
      const roomIssue = roomProblem(result.room);
      if (roomIssue) {
        toast.warning(`${candidate.principal.handle} was assigned`, { description: roomIssue });
      }
      onAssigned({ principal: candidate.principal, stationId: station.id });
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
          {#if offered.length === 0}
            <p class="text-xs text-muted-foreground" data-testid="no-available-agents">
              No other agent principals right now — create a new one instead.
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
                {#each offered as c (c.principal.id)}
                  <Select.Item value={c.principal.id}>{labelFor(c)}</Select.Item>
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
