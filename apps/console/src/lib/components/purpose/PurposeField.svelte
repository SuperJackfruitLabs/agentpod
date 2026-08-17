<script lang="ts">
  // Saying what an agent — or a whole node's worth of them — is for.
  //
  // One field, two callers. On a station it sets that agent's purpose; on a
  // node it sets the default future adoptions inherit AND labels the agents
  // there that have none, which is a write to rows the operator did not name
  // and so is stated in the hint before it happens rather than reported after.
  //
  // The rules live in `purpose.ts` — what an empty box means, whether saving
  // would change anything, how long is too long — because they are the part
  // worth testing without a DOM, which is this codebase's pattern everywhere
  // its page tests cannot reach.

  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import { toast } from "svelte-sonner";
  import {
    normalisePurpose,
    purposeChanged,
    purposeProblem,
    PURPOSE_MAX,
  } from "./purpose";

  let {
    value,
    label = "Purpose",
    hint,
    id,
    onSave,
  }: {
    /** What it is now — null when nobody has said. */
    value: string | null;
    label?: string;
    /** What saving will do beyond this one row, when that is worth saying. */
    hint?: string;
    id: string;
    onSave: (purpose: string | null) => Promise<void>;
  } = $props();

  // Seeded empty and filled by the effect below rather than from `value`
  // directly: reading a prop in a `$state` initialiser captures only its first
  // value, and this field has to follow a purpose set from somewhere else — a
  // node's default landing on this station, most often.
  let draft = $state("");
  let saving = $state(false);

  // Follows the server when it changes underneath — a node purpose that just
  // labelled this station, most often. Guarded on `saving` so a reload landing
  // mid-edit cannot overwrite what is being typed.
  $effect(() => {
    if (!saving) draft = value ?? "";
  });

  const problem = $derived(purposeProblem(draft));
  const changed = $derived(purposeChanged(draft, value));

  async function save() {
    if (problem !== null || !changed || saving) return;
    saving = true;
    try {
      const next = normalisePurpose(draft);
      await onSave(next);
      toast.success(next === null ? "Purpose cleared" : `Purpose set to ${next}`);
    } catch (e) {
      // Loudly: the field keeps showing what was typed, so a silent failure
      // would look exactly like a success.
      toast.error(e instanceof Error ? e.message : "Couldn’t set the purpose.");
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-2">
  <Label for={id}>{label}</Label>
  <div class="flex items-start gap-2">
    <Input
      {id}
      bind:value={draft}
      maxlength={PURPOSE_MAX}
      placeholder="personal, work, …"
      class="max-w-xs"
      aria-invalid={problem !== null}
      aria-describedby="{id}-hint"
      onkeydown={(e: KeyboardEvent) => {
        if (e.key === "Enter") void save();
      }}
    />
    <Button size="sm" disabled={saving || !changed || problem !== null} onclick={() => void save()}>
      {saving ? "Saving…" : "Save"}
    </Button>
  </div>
  <p id="{id}-hint" class="text-xs text-muted-foreground">
    {#if problem !== null}
      <span class="text-destructive">{problem}</span>
    {:else if hint}
      {hint}
    {:else}
      Groups this agent's Matrix room. Leave it empty and it stays in All rooms.
    {/if}
  </p>
</div>
