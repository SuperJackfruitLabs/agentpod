<script lang="ts">
  /**
   * An API key the console may write but never read back.
   *
   * The hub answers only `hasApiKey`, so a saved key is shown as "•••• saved"
   * with Replace and Clear, and `value` is what the next save will do with it:
   * `undefined` keeps it, `null` clears it, a string replaces it. With no key
   * saved it is a plain password box.
   */
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import type { ApiKeyWrite } from "$lib/api/transcription";

  let {
    id,
    hasApiKey,
    value = $bindable(),
    disabled = false,
    label = "API key",
  }: {
    id: string;
    hasApiKey: boolean;
    value?: ApiKeyWrite;
    disabled?: boolean;
    label?: string;
  } = $props();

  let editing = $state(false);
  let draft = $state("");

  const cleared = $derived(hasApiKey && value === null);
  const showInput = $derived(!hasApiKey || editing);

  function replace() {
    editing = true;
    draft = "";
    value = undefined;
  }

  function clear() {
    editing = false;
    draft = "";
    value = null;
  }

  function keep() {
    editing = false;
    draft = "";
    value = undefined;
  }

  function onInput() {
    value = draft === "" ? undefined : draft;
  }
</script>

<div class="space-y-1.5">
  <Label for={showInput ? id : undefined}>{label}</Label>
  {#if showInput}
    <div class="flex items-center gap-2">
      <Input
        {id}
        type="password"
        autocomplete="off"
        spellcheck={false}
        placeholder={hasApiKey ? "New key" : "Optional"}
        bind:value={draft}
        oninput={onInput}
        {disabled}
      />
      {#if hasApiKey}
        <Button variant="ghost" size="sm" onclick={keep} {disabled}>Cancel</Button>
      {/if}
    </div>
  {:else if cleared}
    <div class="flex items-center gap-2 text-sm">
      <span class="text-muted-foreground" data-testid="api-key-cleared">Will be removed on save</span>
      <Button variant="ghost" size="sm" onclick={keep} {disabled}>Undo</Button>
    </div>
  {:else}
    <div class="flex items-center gap-2 text-sm">
      <span class="font-mono text-muted-foreground" data-testid="api-key-saved">•••• saved</span>
      <Button variant="outline" size="sm" onclick={replace} {disabled}>Replace</Button>
      <Button variant="ghost" size="sm" onclick={clear} {disabled}>Clear</Button>
    </div>
  {/if}
</div>
