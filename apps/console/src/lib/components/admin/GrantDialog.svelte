<script lang="ts">
  /**
   * GrantDialog.svelte
   *
   * Edits one principal's control pair — what they may dispatch, and whether
   * they may grant an agent its reach.
   *
   * The form is deliberately a list of exact ids rather than a set of checkboxes
   * over the live directory. A grant outlives the thing it names — an agent can
   * be retired, a principal can be deleted — and a permission that quietly
   * disappeared with it would be a silent narrowing nobody ordered, just as a
   * checkbox list would make a grant on an id this hub does not know
   * unexpressible. Known agents appear as *suggestions* instead, so the common
   * case is one click and the uncommon case is still typable.
   *
   * A value is one agent's principal id and nothing else. There are no
   * wildcards and no plane prefixes; `agentpod:<node>/<stationKey>` is deleted,
   * not deprecated (charter decisions/2026-08-30-an-agent-is-a-principal.md §3).
   */
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
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
    /**
     * The agents this fleet knows, offered as suggestions — `id` is what goes
     * into the grant, `label` is what a person can recognise.
     */
    agentOptions: Array<{ id: string; label: string }>;
    onSaved: () => void;
  }

  let {
    open = $bindable(false),
    principal,
    grant,
    agentOptions = [],
    onSaved,
  }: Props = $props();

  let values = $state<string[]>([]);
  let mayGrantReach = $state(false);
  let draft = $state("");
  let search = $state("");
  let problem = $state<string | null>(null);
  let isSaving = $state(false);

  // Seed from the principal's current grant each time the dialog opens. Edits
  // are local until Save — a half-typed narrowing must never be live.
  $effect(() => {
    if (open) {
      values = [...grant.mayDispatch];
      mayGrantReach = grant.mayGrantReach;
      draft = "";
      search = "";
      problem = null;
    }
  });

  let query = $derived(search.trim().toLowerCase());
  const matches = (id: string, label = "") => `${id} ${label}`.toLowerCase().includes(query);
  let visibleValues = $derived(values.filter((id) => matches(id, labelOf(id) ?? "")));
  let unusedSuggestions = $derived(agentOptions.filter((a) => !values.includes(a.id) && matches(a.id, a.label)));
  let added = $derived(values.filter((id) => !grant.mayDispatch.includes(id)).length);
  let removed = $derived(grant.mayDispatch.filter((id) => !values.includes(id)).length);

  /**
   * A recognisable name for an id, when this hub knows one.
   *
   * The id itself is always shown, never replaced by the label: this is the
   * exact string that will be stored and compared by equality, and a row that
   * showed only "Quill" would hide a typo'd id that grants nothing.
   */
  let labelOf = $derived((id: string) => agentOptions.find((a) => a.id === id)?.label ?? null);

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

<Dialog.Root {open} onOpenChange={(v) => { if (!isSaving) open = v; }}>
  <Dialog.Content
    onEscapeKeydown={(event) => { if (isSaving) event.preventDefault(); }}
    onInteractOutside={(event) => { if (isSaving) event.preventDefault(); }}
    showCloseButton={false} class="flex w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
    <Dialog.Header class="shrink-0 border-b p-4 text-left">
      <Dialog.Title>Edit grant</Dialog.Title>
      <Dialog.Description class="break-words">
        Manage what {principal?.label ?? "this principal"} may dispatch. Changes apply when you save.
      </Dialog.Description>
    </Dialog.Header>

    <div class="min-h-0 overflow-y-auto overscroll-contain p-4" data-testid="grant-scroll-body">
      <fieldset disabled={isSaving} class="min-w-0 space-y-5">
        <div class="space-y-2">
          <Label for="grant-search">Search agents</Label>
          <Input id="grant-search" bind:value={search} placeholder="Filter by name or principal ID" />
          <p class="text-xs text-muted-foreground">Search filters both lists. Hidden targets stay selected.</p>
        </div>

        <section class="space-y-2" aria-label="Selected dispatch targets">
          <h3 class="text-sm font-medium">May dispatch <span class="text-muted-foreground">({values.length} selected)</span></h3>
          {#if values.length === 0}
            <p class="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-testid="grant-empty">
              No dispatch targets. Under enforcement this principal cannot dispatch any agent.
            </p>
          {:else if visibleValues.length === 0}
            <p class="text-sm text-muted-foreground">No selected targets match your search.</p>
          {:else}
            <ul class="divide-y rounded-lg border">
              {#each visibleValues as value (value)}
                <li class="flex min-w-0 items-center gap-3 px-3 py-2">
                  <div class="min-w-0 flex-1">
                    <p class="break-words text-sm font-medium">{labelOf(value) ?? "Not in agent directory"}</p>
                    <p class="break-all font-mono text-xs text-muted-foreground">{value}</p>
                  </div>
                  <Button variant="ghost" size="icon" aria-label="Remove value {value}" onclick={() => removeValue(value)}>
                    <XIcon class="size-4" />
                  </Button>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <section class="space-y-2" aria-label="Available agents">
          <h3 class="text-sm font-medium">Available agents <span class="text-muted-foreground">({unusedSuggestions.length})</span></h3>
          {#if unusedSuggestions.length > 0}
            <ul class="divide-y rounded-lg border">
              {#each unusedSuggestions as suggestion (suggestion.id)}
                <li>
                  <button type="button" class="w-full rounded-md px-3 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                    onclick={() => addValue(suggestion.id)}>
                    <span class="block break-words text-sm font-medium">+ {suggestion.label}</span>
                    <span class="block break-all font-mono text-xs text-muted-foreground">{suggestion.id}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="text-sm text-muted-foreground">{query ? "No available agents match your search." : "No other agents in the directory. You can still add an exact ID below."}</p>
          {/if}
        </section>

        <div class="space-y-2">
          <Label for="grant-value">Add a value by principal ID</Label>
          <div class="flex gap-2">
            <Input id="grant-value" bind:value={draft} placeholder="prn_0123456789abcdef0123" class="min-w-0 font-mono text-xs"
              aria-invalid={!!problem} aria-describedby="grant-value-help"
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === "Enter") { e.preventDefault(); addValue(draft); }
              }} />
            <Button variant="outline" onclick={() => addValue(draft)}>Add</Button>
          </div>
          <p id="grant-value-help" class={problem ? "text-xs text-destructive" : "text-xs text-muted-foreground"} role={problem ? "alert" : undefined}>
            {problem ?? "Use prn_ followed by 20 hex characters. IDs match exactly; wildcards are not supported."}
          </p>
        </div>

        <div class="flex items-start justify-between gap-4 rounded-lg border p-3">
          <div class="min-w-0 space-y-1">
            <Label for="may-grant-reach">May grant reach</Label>
            <p class="text-xs text-muted-foreground">
              Allow changes to an agent’s reach: workspace writes, terminals, file deletion, or adding a machine. Dispatch targets above do not require this permission.
            </p>
          </div>
          <Switch id="may-grant-reach" bind:checked={mayGrantReach} disabled={isSaving} class="shrink-0" />
        </div>
      </fieldset>
    </div>

    <div class="shrink-0 space-y-3 border-t bg-popover p-4">
      <p class="text-xs text-muted-foreground" role="status">
        {added} added · {removed} removed · Reach {mayGrantReach === grant.mayGrantReach ? "unchanged" : mayGrantReach ? "enabled" : "disabled"}
      </p>
      <Dialog.Footer class="flex-row justify-end">
        <Button variant="outline" onclick={() => (open = false)} disabled={isSaving}>Cancel</Button>
        <Button onclick={handleSave} disabled={isSaving}>{isSaving ? "Saving…" : "Save grant"}</Button>
      </Dialog.Footer>
    </div>
  </Dialog.Content>
</Dialog.Root>
