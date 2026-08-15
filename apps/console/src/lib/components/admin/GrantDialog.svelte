<script lang="ts">
  /**
   * GrantDialog.svelte
   *
   * Edits one principal's control pair — what they may dispatch, and whether
   * they may grant an agent its reach.
   *
   * The form is deliberately a list of exact strings rather than a set of
   * checkboxes over live stations. A grant outlives the station it names: nodes
   * are reprovisioned, stations are re-adopted, and a permission that quietly
   * disappeared with its station would be a silent widening or narrowing nobody
   * ordered. Live stations appear as *suggestions* instead, so the common case is
   * one click and the uncommon case is still expressible.
   */
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { Badge } from "$lib/components/ui/badge";
  import { toast } from "svelte-sonner";
  import XIcon from "@lucide/svelte/icons/x";
  import { setGrant, grantValueProblem, type Grant } from "$lib/api/grants";

  interface GrantPrincipal {
    id: string;
    label: string;
  }

  interface Props {
    open: boolean;
    principal: GrantPrincipal | null;
    grant: Grant;
    /** Live `agentpod:<node>/<stationKey>` values, offered as suggestions. */
    stationValues: string[];
    onSaved: () => void;
  }

  let {
    open = $bindable(false),
    principal,
    grant,
    stationValues = [],
    onSaved,
  }: Props = $props();

  let values = $state<string[]>([]);
  let mayGrantReach = $state(false);
  let draft = $state("");
  let problem = $state<string | null>(null);
  let isSaving = $state(false);

  // Seed from the principal's current grant each time the dialog opens. Edits
  // are local until Save — a half-typed narrowing must never be live.
  $effect(() => {
    if (open) {
      values = [...grant.mayDispatch];
      mayGrantReach = grant.mayGrantReach;
      draft = "";
      problem = null;
    }
  });

  let unusedSuggestions = $derived(stationValues.filter((v) => !values.includes(v)).slice(0, 8));

  function addValue(value: string): boolean {
    const trimmed = value.trim();
    const why = grantValueProblem(trimmed);
    if (why) {
      problem = why;
      return false;
    }
    // A duplicate grants nothing extra and makes the list harder to read, which
    // is how an over-wide value hides in a long grant.
    if (!values.includes(trimmed)) values = [...values, trimmed];
    draft = "";
    problem = null;
    return true;
  }

  function removeValue(value: string) {
    values = values.filter((v) => v !== value);
  }

  async function handleSave() {
    if (!principal || isSaving) return;

    // A value still in the box is a value the person believes they are saving.
    // Adding it here means Save-without-Add works; refusing to save while it is
    // invalid means a rejected value is never silently dropped, which would
    // leave someone certain they had granted something they had not.
    if (draft.trim() !== "" && !addValue(draft)) return;

    isSaving = true;
    try {
      // Whole-object: the endpoint replaces rather than merges, so this is the
      // grant afterwards, not an addition to it.
      await setGrant(principal.id, { mayDispatch: values, mayGrantReach });
      toast.success(`Grant saved for ${principal.label}`);
      open = false;
      onSaved();
    } catch (e) {
      // The dialog stays open with the edits intact: losing a half-written grant
      // to a network blip is how people end up applying a wider one next time.
      toast.error("Couldn’t save grant", { description: (e as Error).message });
    } finally {
      isSaving = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={(v) => (open = v)}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content showCloseButton={false} class="max-w-lg">
      <Dialog.Header>
        <Dialog.Title>Grant</Dialog.Title>
        <Dialog.Description>
          What {principal?.label ?? "this principal"} may dispatch. Replaces the current grant.
        </Dialog.Description>
      </Dialog.Header>

      <div class="space-y-4 py-2">
        <div class="space-y-2">
          <Label>May dispatch</Label>
          {#if values.length === 0}
            <p class="text-xs text-muted-foreground" data-testid="grant-empty">
              Nothing. Under enforcement this principal is refused everywhere.
            </p>
          {:else}
            <ul class="flex flex-wrap gap-2">
              {#each values as value (value)}
                <li>
                  <Badge variant="outline" class="gap-1 font-mono text-xs">
                    {value}
                    <button
                      type="button"
                      aria-label="Remove value {value}"
                      class="text-muted-foreground hover:text-destructive"
                      onclick={() => removeValue(value)}
                    >
                      <XIcon class="h-3 w-3" />
                    </button>
                  </Badge>
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <div class="space-y-2">
          <Label for="grant-value">Add a value</Label>
          <div class="flex gap-2">
            <Input
              id="grant-value"
              bind:value={draft}
              placeholder="agentpod:node/hermes:agent — or kaambaan:agt_…"
              class="font-mono text-xs"
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addValue(draft);
                }
              }}
            />
            <Button variant="outline" onclick={() => addValue(draft)}>Add</Button>
          </div>
          {#if problem}
            <p class="text-xs text-destructive" role="alert">{problem}</p>
          {:else}
            <p class="text-xs text-muted-foreground">
              An AgentPod value names a node as well as a station — station keys repeat across
              nodes. Fleet-wide is written out: <code>agentpod:*/hermes:*</code>.
            </p>
          {/if}

          {#if unusedSuggestions.length > 0}
            <div class="flex flex-wrap gap-1 pt-1">
              {#each unusedSuggestions as suggestion (suggestion)}
                <button
                  type="button"
                  class="rounded border border-dashed px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
                  onclick={() => addValue(suggestion)}
                >
                  + {suggestion}
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <div class="flex items-start justify-between gap-4 rounded-lg border p-3">
          <div class="space-y-0.5">
            <Label for="may-grant-reach">May grant reach</Label>
            <p class="text-xs text-muted-foreground">
              The second half of the pair: whether this principal may widen what an agent can
              reach. Not yet enforced anywhere — recorded so it is decided before it is needed.
            </p>
          </div>
          <Switch id="may-grant-reach" bind:checked={mayGrantReach} />
        </div>
      </div>

      <Dialog.Footer>
        <Button variant="outline" onclick={() => (open = false)} disabled={isSaving}>Cancel</Button>
        <Button onclick={handleSave} disabled={isSaving}>
          {isSaving ? "Saving…" : "Save grant"}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
