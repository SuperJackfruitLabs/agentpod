<script lang="ts">
  /**
   * Where a transcription service is and how to ask it: provider, URL, model,
   * API key, and the longest voice note it will be sent. Shared by the hub
   * default (Admin → Transcription) and a station's custom override.
   *
   * Choosing a provider fills the URL and model; editing them afterwards is
   * fine — the provider list is a shortcut, not a constraint.
   */
  import { untrack } from "svelte";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import ApiKeyField from "./ApiKeyField.svelte";
  import type { ApiKeyWrite } from "$lib/api/transcription";
  import {
    MAX_MAX_SECONDS,
    MIN_MAX_SECONDS,
    PRESETS,
    maxSecondsProblem,
    presetFor,
    urlProblem,
    type PresetId,
  } from "./transcription";

  let {
    idPrefix,
    url = $bindable(""),
    model = $bindable(""),
    maxSeconds = $bindable(300),
    apiKey = $bindable(),
    hasApiKey,
    urlRequired = true,
    disabled = false,
  }: {
    idPrefix: string;
    url?: string;
    model?: string;
    maxSeconds?: number;
    apiKey?: ApiKeyWrite;
    hasApiKey: boolean;
    urlRequired?: boolean;
    disabled?: boolean;
  } = $props();

  // Seeded from the saved URL once; after that it is the operator's choice.
  let preset = $state<PresetId>(untrack(() => presetFor(url)));

  const current = $derived(PRESETS.find((p) => p.id === preset)!);
  const urlError = $derived(urlProblem(url, { required: urlRequired }));
  const secondsError = $derived(maxSecondsProblem(maxSeconds));

  function choosePreset(id: PresetId) {
    preset = id;
    const p = PRESETS.find((x) => x.id === id)!;
    if (p.url) url = p.url;
    if (p.models.length > 0 && !p.models.includes(model)) model = p.models[0]!;
  }
</script>

<div class="space-y-3">
  <div class="space-y-1.5">
    <Label for="{idPrefix}-provider">Provider</Label>
    <select
      id="{idPrefix}-provider"
      class="w-full rounded-md border bg-background p-2 text-sm"
      value={preset}
      onchange={(e) => choosePreset((e.currentTarget as HTMLSelectElement).value as PresetId)}
      {disabled}
    >
      {#each PRESETS as p (p.id)}
        <option value={p.id}>{p.label}</option>
      {/each}
    </select>
    <p class="text-xs text-muted-foreground">{current.hint}</p>
  </div>

  <div class="space-y-1.5">
    <Label for="{idPrefix}-url">URL</Label>
    <Input
      id="{idPrefix}-url"
      bind:value={url}
      placeholder="http://transcriber:8840"
      aria-invalid={urlError !== null}
      spellcheck={false}
      {disabled}
    />
    {#if urlError}
      <p class="text-xs text-destructive">{urlError}</p>
    {:else}
      <p class="text-xs text-muted-foreground">The base address; the hub adds /v1/audio/transcriptions.</p>
    {/if}
  </div>

  <div class="space-y-1.5">
    <Label for="{idPrefix}-model">Model</Label>
    <Input
      id="{idPrefix}-model"
      bind:value={model}
      list="{idPrefix}-models"
      placeholder="large-v3-turbo"
      spellcheck={false}
      {disabled}
    />
    <datalist id="{idPrefix}-models">
      {#each current.models as m (m)}
        <option value={m}></option>
      {/each}
    </datalist>
  </div>

  <ApiKeyField id="{idPrefix}-key" {hasApiKey} bind:value={apiKey} {disabled} />

  <div class="space-y-1.5">
    <Label for="{idPrefix}-max">Longest voice note (seconds)</Label>
    <Input
      id="{idPrefix}-max"
      type="number"
      min={MIN_MAX_SECONDS}
      max={MAX_MAX_SECONDS}
      step={1}
      bind:value={maxSeconds}
      aria-invalid={secondsError !== null}
      class="max-w-32"
      {disabled}
    />
    {#if secondsError}
      <p class="text-xs text-destructive">{secondsError}</p>
    {:else}
      <p class="text-xs text-muted-foreground">Longer notes are named to the agent, not transcribed.</p>
    {/if}
  </div>
</div>
