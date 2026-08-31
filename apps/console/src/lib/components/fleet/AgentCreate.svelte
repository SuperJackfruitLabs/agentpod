<script lang="ts">
  /**
   * AgentCreate.svelte
   *
   * Mints an agent principal and, in the common case, puts it straight into
   * a station — the two acts `apps/hub/src/routes/agents-admin.ts` keeps
   * separate (a bad handle and a suspended assignee are different refusals)
   * but that read as one action from here.
   *
   * Two shapes, one component:
   *  - `station` fixed: "Create an agent for this station." There is
   *    nothing to pick — the target is already decided, and the handle
   *    pre-fills from the station key (`hermes:writer-quill` → `writer-quill`,
   *    the part an operator would actually type).
   *  - `station` absent, `stationOptions` given: the same action reached
   *    from /agents, offered a pick among the stations that are currently
   *    unassigned. Assigning stays optional even here — minting an agent
   *    ahead of a station existing for it is a legitimate order of events.
   *
   * The handle field never implies it can be edited later — because it
   * can't (`charter → decisions/2026-08-30-an-agent-is-a-principal.md`): it
   * is what the agent's Matrix address is built from, fixed at mint time.
   */
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import { Field } from "$lib/components/ui/field";
  import { Spinner } from "$lib/components/ui/spinner";
  import { toast } from "svelte-sonner";
  import { createAgent, assignStationAgent, defaultHandleFromStationKey, roomProblem, type CreatedAgent } from "$lib/api/agents";

  export interface StationOption {
    id: string;
    stationKey: string;
    displayName: string;
    nodeName?: string;
  }

  interface Props {
    open: boolean;
    /** A fixed target — "Create an agent for this station." Nothing to pick. */
    station?: StationOption | null;
    /**
     * Offered only when `station` is not fixed: currently-unassigned
     * stations to optionally assign the new agent to.
     */
    stationOptions?: StationOption[];
    onCreated: (result: { principal: CreatedAgent; stationId: string | null }) => void;
  }

  let { open = $bindable(false), station = null, stationOptions = [], onCreated }: Props = $props();

  let handle = $state("");
  let handleTouched = $state(false);
  let displayName = $state("");
  let selectedStationId = $state<string | null>(null);
  let isCreating = $state(false);
  let handleProblem = $state<string | null>(null);

  function optionFor(id: string | null): StationOption | null {
    if (station) return station;
    return stationOptions.find((s) => s.id === id) ?? null;
  }

  // Reset — and re-derive the prefill — every time the dialog opens, not
  // just once at mount: the same instance can be reused across stations.
  $effect(() => {
    if (open) {
      selectedStationId = station?.id ?? null;
      handle = station ? defaultHandleFromStationKey(station.stationKey) : "";
      handleTouched = false;
      displayName = "";
      isCreating = false;
      handleProblem = null;
    }
  });

  function handleStationSelect(id: string | undefined) {
    selectedStationId = id ?? null;
    // Re-derive the suggested handle on selection — but only while the
    // operator hasn't typed one themselves. Overwriting a typed handle
    // because a picker changed would be the same silent-rewrite the hub
    // itself refuses to do.
    if (!station && !handleTouched) {
      const opt = optionFor(selectedStationId);
      handle = opt ? defaultHandleFromStationKey(opt.stationKey) : "";
    }
  }

  async function handleSubmit() {
    const trimmed = handle.trim();
    if (!trimmed || isCreating) return;

    isCreating = true;
    handleProblem = null;
    try {
      const principal = await createAgent({
        handle: trimmed,
        displayName: displayName.trim() || undefined,
      });

      let stationId: string | null = null;
      if (selectedStationId) {
        try {
          const result = await assignStationAgent(selectedStationId, principal.id);
          stationId = selectedStationId;
          // Assigned, but with no room. A third state beside "created" and
          // "created but not assigned", and it gets its own sentence for the
          // same reason those do — the assignment stands, so it is not an
          // error, and it is not nothing either.
          const roomIssue = roomProblem(result.room);
          if (roomIssue) {
            toast.warning(`${principal.handle} created and assigned`, { description: roomIssue });
            open = false;
            onCreated({ principal, stationId });
            return;
          }
        } catch (assignErr) {
          // The principal exists now even though the assignment failed —
          // reporting this as a failed create would strand an identity the
          // operator would then try to create again and hit 409 on. It
          // exists, unassigned; say so and let the list pick it up.
          toast.error("Agent created, but couldn't be assigned", {
            description: (assignErr as Error).message,
          });
          open = false;
          onCreated({ principal, stationId: null });
          return;
        }
      }

      toast.success(stationId ? `${principal.handle} created and assigned` : `${principal.handle} created`);
      open = false;
      onCreated({ principal, stationId });
    } catch (e) {
      // The hub's own sentence — "handle already taken", "handle would be
      // altered…" — not a generic failure. http-error.ts already turns it
      // into a readable one.
      handleProblem = (e as Error).message;
    } finally {
      isCreating = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={(v) => (open = v)}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content showCloseButton={false}>
      <Dialog.Header>
        <Dialog.Title>{station ? `Create an agent for ${station.displayName}` : "Create an agent"}</Dialog.Title>
        <Dialog.Description>
          {#if station}
            Mints a new agent principal and puts it in this station — it is dispatchable by nobody
            until then.
          {:else}
            Mints a new agent principal. Assign it to a station now, or leave it unassigned to
            place later.
          {/if}
        </Dialog.Description>
      </Dialog.Header>

      <!-- novalidate: the Field-level error below owns this, not the browser's bubble. -->
      <form
        novalidate
        onsubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
        class="space-y-4 py-2"
      >
        <Field
          label="Handle"
          for="agent-handle"
          error={handleProblem ?? undefined}
          description={handleProblem
            ? undefined
            : "Becomes this agent's Matrix address. Can't be changed after it's created."}
        >
          <Input
            id="agent-handle"
            name="handle"
            autocomplete="off"
            spellcheck={false}
            bind:value={handle}
            oninput={() => (handleTouched = true)}
            required
            disabled={isCreating}
          />
        </Field>

        <Field label="Display name (optional)" for="agent-display-name">
          <Input id="agent-display-name" name="displayName" bind:value={displayName} disabled={isCreating} />
        </Field>

        {#if station}
          <Field label="Station" for="agent-station-fixed">
            <p id="agent-station-fixed" class="text-sm text-muted-foreground">
              {station.displayName}{station.nodeName ? ` · ${station.nodeName}` : ""}
            </p>
          </Field>
        {:else}
          <Field label="Assign to station" for="agent-station">
            {#if stationOptions.length === 0}
              <p class="text-xs text-muted-foreground" data-testid="no-unassigned-stations">
                No unassigned stations right now — this creates the agent without one; assign it
                from the station once it's here.
              </p>
            {:else}
              <Select.Root
                type="single"
                value={selectedStationId ?? ""}
                onValueChange={(v) => handleStationSelect(v || undefined)}
              >
                <Select.Trigger class="w-full" id="agent-station">
                  {selectedStationId ? (optionFor(selectedStationId)?.displayName ?? "Leave unassigned") : "Leave unassigned"}
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="">Leave unassigned</Select.Item>
                  {#each stationOptions as opt (opt.id)}
                    <Select.Item value={opt.id}>
                      {opt.displayName}{opt.nodeName ? ` · ${opt.nodeName}` : ""}
                    </Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            {/if}
          </Field>
        {/if}

        <!-- Footer lives INSIDE the form so Enter in any field submits natively. -->
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={() => (open = false)} disabled={isCreating}>
            Cancel
          </Button>
          <Button type="submit" disabled={isCreating || !handle.trim()}>
            {#if isCreating}<Spinner size="sm" class="text-primary-foreground" />{/if}
            {isCreating ? "Creating…" : "Create agent"}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
