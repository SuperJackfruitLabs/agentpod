<script lang="ts">
  /**
   * Voice notes, for one station: inherit the hub default, off, or a service
   * of its own. Whatever the choice, it says which service is actually in
   * effect — "inherit" alone tells an operator nothing about what an agent
   * will hear.
   *
   * For a bridge-mode station the hub transcribes, so saving here takes
   * effect on the next voice note. A harness-mode station runs its own Matrix
   * client and hears voice notes itself, so the saved setting reaches it only
   * when its node writes it into the harness profile — "Apply to harness"
   * (`transcription.apply`), which says whether the harness was restarted.
   */
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import TranscriptionFields from "$lib/components/transcription/TranscriptionFields.svelte";
  import {
    DEFAULT_MAX_SECONDS,
    DEFAULT_MODEL,
    describeSource,
    formatSeconds,
    maxSecondsProblem,
    providerName,
    urlProblem,
  } from "$lib/components/transcription/transcription";
  import {
    applyStationTranscription,
    getStationTranscription,
    saveStationTranscription,
    type ApiKeyWrite,
    type StationTranscription,
    type StationTranscriptionInput,
    type StationTranscriptionMode,
    type TranscriptionApplyResult,
  } from "$lib/api/transcription";

  let {
    stationId,
    harnessMode = false,
    load = getStationTranscription,
    save = saveStationTranscription,
    apply = applyStationTranscription,
  }: {
    stationId: string;
    /** `matrixIdentityMode === "harness"`: the harness hears voice notes itself. */
    harnessMode?: boolean;
    load?: (stationId: string) => Promise<StationTranscription>;
    save?: (stationId: string, input: StationTranscriptionInput) => Promise<StationTranscription>;
    apply?: (stationId: string) => Promise<TranscriptionApplyResult>;
  } = $props();

  let applying = $state(false);
  let applied = $state<TranscriptionApplyResult | null>(null);
  let applyError = $state<string | null>(null);

  async function onApply() {
    if (applying) return;
    applying = true;
    applied = null;
    applyError = null;
    try {
      applied = await apply(stationId);
    } catch (e) {
      applyError = e instanceof Error ? e.message : "Couldn’t apply the setting to the harness.";
    } finally {
      applying = false;
    }
  }

  let loaded = $state<StationTranscription | null>(null);
  let loadError = $state<string | null>(null);
  let version = $state(0);

  let mode = $state<StationTranscriptionMode>("inherit");
  let url = $state("");
  let model = $state(DEFAULT_MODEL);
  let maxSeconds = $state(DEFAULT_MAX_SECONDS);
  let apiKey = $state<ApiKeyWrite>(undefined);
  let saving = $state(false);

  function adopt(view: StationTranscription) {
    loaded = view;
    mode = view.mode;
    url = view.url ?? "";
    model = view.model ?? DEFAULT_MODEL;
    maxSeconds = view.maxSeconds ?? DEFAULT_MAX_SECONDS;
    apiKey = undefined;
    version++;
  }

  onMount(async () => {
    try {
      adopt(await load(stationId));
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Couldn’t read this station's voice-note setting.";
    }
  });

  const problem = $derived(
    mode === "custom" ? (urlProblem(url, { required: true }) ?? maxSecondsProblem(maxSeconds)) : null
  );

  const changed = $derived(
    loaded !== null &&
      (mode !== loaded.mode ||
        (mode === "custom" &&
          (url !== (loaded.url ?? "") ||
            model !== (loaded.model ?? DEFAULT_MODEL) ||
            maxSeconds !== (loaded.maxSeconds ?? DEFAULT_MAX_SECONDS) ||
            apiKey !== undefined)))
  );

  async function onSave() {
    if (problem !== null || saving) return;
    saving = true;
    try {
      const body: StationTranscriptionInput =
        mode === "custom" ? { mode, url: url.trim(), model: model.trim(), maxSeconds } : { mode };
      if (mode === "custom" && apiKey !== undefined) body.apiKey = apiKey;
      adopt(await save(stationId, body));
      toast.success("Voice-note setting saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn’t save the voice-note setting.");
    } finally {
      saving = false;
    }
  }

  const MODES: Array<{ value: StationTranscriptionMode; label: string }> = [
    { value: "inherit", label: "Inherit hub default" },
    { value: "off", label: "Off" },
    { value: "custom", label: "Custom" },
  ];
</script>

<div class="space-y-3" data-testid="voice-notes">
  {#if loadError}
    <p class="text-xs text-destructive" role="alert">{loadError}</p>
  {:else if loaded === null}
    <p class="text-xs text-muted-foreground">Reading…</p>
  {:else}
    <fieldset class="space-y-1.5" disabled={saving}>
      <legend class="sr-only">Voice-note transcription for this station</legend>
      {#each MODES as m (m.value)}
        <label class="flex items-center gap-2">
          <input type="radio" name="voice-mode-{stationId}" value={m.value} bind:group={mode} />
          <span>{m.label}</span>
        </label>
      {/each}
    </fieldset>

    {#if mode === "custom"}
      {#key version}
        <TranscriptionFields
          idPrefix="station-voice-{stationId}"
          bind:url
          bind:model
          bind:maxSeconds
          bind:apiKey
          hasApiKey={loaded.hasApiKey}
          disabled={saving}
        />
      {/key}
    {/if}

    <p class="text-xs text-muted-foreground" data-testid="voice-effective">
      {#if loaded.effective.enabled}
        In effect: {providerName(loaded.effective.url)} · {loaded.effective.model} · up to
        {formatSeconds(loaded.effective.maxSeconds ?? DEFAULT_MAX_SECONDS)}. {describeSource(loaded.effective.source)}
      {:else}
        Voice notes are not transcribed for this station — the agent is told one arrived.
      {/if}
    </p>

    <Button size="sm" onclick={() => void onSave()} disabled={saving || !changed || problem !== null}>
      {saving ? "Saving…" : "Save"}
    </Button>

    {#if harnessMode}
      <div class="space-y-2 border-t border-border pt-3">
        <p class="text-xs text-muted-foreground" data-testid="voice-harness-note">
          This agent runs its own Matrix client, so its harness transcribes voice notes itself. Save, then
          apply to write the setting into its harness profile.
        </p>
        <Button
          size="sm"
          variant="outline"
          onclick={() => void onApply()}
          disabled={applying || saving || changed}
          title={changed ? "Save your changes first" : undefined}
        >
          {applying ? "Applying…" : "Apply to harness"}
        </Button>
        {#if applyError}
          <p class="text-xs text-destructive" role="alert">{applyError}</p>
        {:else if applied}
          <p class="text-xs text-muted-foreground" data-testid="voice-apply-result" aria-live="polite">
            {applied.restarted ? "Applied — restarted." : "Applied — restart the gateway to pick it up."}
          </p>
        {/if}
      </div>
    {/if}
  {/if}
</div>
