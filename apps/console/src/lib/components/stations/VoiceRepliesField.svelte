<script lang="ts">
  /**
   * Voice replies, for one station: which voice it speaks in and when.
   *
   * The voice defaults to one assigned from the station's id (or the hub's
   * default voice, if an admin set one), shown as such, and the owner may
   * pick another or type a blend. "When it speaks" inherits the hub's unless
   * set here. The speech service itself is inherited; a station may turn it
   * off or name its own under "Speech service".
   *
   * A harness-mode agent is its own Matrix client and speaks for itself, so
   * the saved voice reaches it only when its node writes it into the harness
   * profile — "Apply to harness" (`speech.apply`), which says whether the
   * harness was restarted and what it will now do on its own (Hermes has no
   * profile setting for "only when spoken to"; docs/OPERATING.md §7d).
   */
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import ApiKeyField from "$lib/components/transcription/ApiKeyField.svelte";
  import VoicePicker from "$lib/components/speech/VoicePicker.svelte";
  import { providerName, urlProblem } from "$lib/components/transcription/transcription";
  import { describeSpeechSource, SPEAK_MODE_LABELS, voiceLabel, voiceProblem } from "$lib/components/speech/speech";
  import {
    applyStationSpeech,
    getStationSpeech,
    listVoices,
    saveStationSpeech,
    type ApiKeyWrite,
    type SpeakMode,
    type SpeechApplyResult,
    type StationSpeech,
    type StationSpeechInput,
    type StationSpeechMode,
    type VoiceInfo,
    type VoiceList,
  } from "$lib/api/speech";

  let {
    stationId,
    harnessMode = false,
    load = getStationSpeech,
    save = saveStationSpeech,
    loadVoices = listVoices,
    apply = applyStationSpeech,
    preview,
    play,
  }: {
    stationId: string;
    harnessMode?: boolean;
    load?: (stationId: string) => Promise<StationSpeech>;
    save?: (stationId: string, input: StationSpeechInput) => Promise<StationSpeech>;
    loadVoices?: () => Promise<VoiceList>;
    apply?: (stationId: string) => Promise<SpeechApplyResult>;
    preview?: (voiceId: string) => Promise<Blob>;
    play?: (audio: Blob) => unknown;
  } = $props();

  let loaded = $state<StationSpeech | null>(null);
  let loadError = $state<string | null>(null);
  let version = $state(0);

  let voice = $state("");
  /** "" = inherit the hub's. */
  let speakMode = $state<SpeakMode | "">("");
  let serviceMode = $state<StationSpeechMode>("inherit");
  let url = $state("");
  let apiKey = $state<ApiKeyWrite>(undefined);
  let saving = $state(false);

  let applying = $state(false);
  let applied = $state<SpeechApplyResult | null>(null);
  let applyError = $state<string | null>(null);

  async function onApply() {
    if (applying) return;
    applying = true;
    applied = null;
    applyError = null;
    try {
      applied = await apply(stationId);
    } catch (e) {
      applyError = e instanceof Error ? e.message : "Couldn’t apply the voice to the harness.";
    } finally {
      applying = false;
    }
  }

  /** What the harness will now do, in words — which is not always what was asked. */
  function appliedBehaviour(r: SpeechApplyResult): string {
    if (r.mode === "off") return "No speech service for this station, so the agent no longer speaks on its own.";
    if (r.autoSpeak) return "It now speaks every reply aloud.";
    if (r.speakMode === "voice_in") {
      return (
        "Hermes has no setting for “only when spoken to”, so it will not speak on its own: send /voice on " +
        "in a room to have it answer voice notes with voice there."
      );
    }
    return "It speaks only when it chooses to (its text-to-speech tool).";
  }

  let voices = $state<VoiceInfo[] | null>(null);
  let voicesError = $state<string | null>(null);

  function adopt(view: StationSpeech) {
    loaded = view;
    voice = view.voice ?? "";
    speakMode = view.speakMode ?? "";
    serviceMode = view.mode;
    url = view.url ?? "";
    apiKey = undefined;
    version++;
  }

  onMount(async () => {
    try {
      adopt(await load(stationId));
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Couldn’t read this station's voice settings.";
      return;
    }
    try {
      voices = (await loadVoices()).voices;
    } catch (e) {
      voices = [];
      voicesError = e instanceof Error ? e.message : "no answer";
    }
  });

  /** What "" falls back to: the hub's default voice, else the one assigned from the station's id. */
  const fallbackVoice = $derived(loaded?.inheritedVoice ?? "");
  const fallbackLabel = $derived(
    loaded === null
      ? ""
      : `${loaded.inheritedVoiceSource === "hub" ? "Hub default" : "Assigned"}: ${voiceLabel(loaded.inheritedVoice, voices ?? [])}`
  );

  const problem = $derived(
    voiceProblem(voice) ?? (serviceMode === "custom" ? urlProblem(url, { required: true }) : null)
  );

  const changed = $derived(
    loaded !== null &&
      (voice !== (loaded.voice ?? "") ||
        speakMode !== (loaded.speakMode ?? "") ||
        serviceMode !== loaded.mode ||
        (serviceMode === "custom" && (url !== (loaded.url ?? "") || apiKey !== undefined)))
  );

  async function onSave() {
    if (problem !== null || saving) return;
    saving = true;
    try {
      const body: StationSpeechInput = {
        mode: serviceMode,
        voice: voice.trim() === "" ? null : voice.trim(),
        speakMode: speakMode === "" ? null : speakMode,
      };
      if (serviceMode === "custom") {
        body.url = url.trim();
        if (apiKey !== undefined) body.apiKey = apiKey;
      }
      adopt(await save(stationId, body));
      toast.success("Voice settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn’t save the voice settings.");
    } finally {
      saving = false;
    }
  }

  const SPEAK_CHOICES: Array<{ value: SpeakMode | ""; label: string }> = [
    { value: "", label: "Hub default" },
    { value: "off", label: SPEAK_MODE_LABELS.off },
    { value: "voice_in", label: SPEAK_MODE_LABELS.voice_in },
    { value: "always", label: SPEAK_MODE_LABELS.always },
  ];
  const SERVICE_CHOICES: Array<{ value: StationSpeechMode; label: string }> = [
    { value: "inherit", label: "Inherit hub default" },
    { value: "off", label: "Off" },
    { value: "custom", label: "Custom" },
  ];
</script>

<div class="space-y-3" data-testid="voice-replies">
  {#if loadError}
    <p class="text-xs text-destructive" role="alert">{loadError}</p>
  {:else if loaded === null}
    <p class="text-xs text-muted-foreground">Reading…</p>
  {:else}
    <VoicePicker
      id="station-voice-{stationId}"
      bind:value={voice}
      {voices}
      {voicesError}
      emptyLabel={fallbackLabel}
      {fallbackVoice}
      disabled={saving}
      {...preview ? { preview } : {}}
      {...play ? { play } : {}}
    />

    <fieldset class="space-y-1.5" disabled={saving}>
      <legend class="text-sm font-medium">Speak replies</legend>
      {#each SPEAK_CHOICES as m (m.value)}
        <label class="flex items-center gap-2 text-sm">
          <input type="radio" name="speak-mode-{stationId}" value={m.value} bind:group={speakMode} />
          <span>{m.label}{m.value === "" ? ` (${SPEAK_MODE_LABELS[loaded.effective.speakMode].toLowerCase()})` : ""}</span>
        </label>
      {/each}
    </fieldset>

    <details class="text-sm" open={loaded.mode !== "inherit"}>
      <summary class="cursor-pointer text-muted-foreground">Speech service</summary>
      <fieldset class="mt-2 space-y-1.5" disabled={saving}>
        <legend class="sr-only">Speech service for this station</legend>
        {#each SERVICE_CHOICES as m (m.value)}
          <label class="flex items-center gap-2">
            <input type="radio" name="speech-service-{stationId}" value={m.value} bind:group={serviceMode} />
            <span>{m.label}</span>
          </label>
        {/each}
      </fieldset>
      {#if serviceMode === "custom"}
        <div class="mt-2 space-y-2">
          <div class="space-y-1.5">
            <Label for="station-speech-url-{stationId}">Service URL</Label>
            <Input id="station-speech-url-{stationId}" spellcheck={false} autocomplete="off" bind:value={url} disabled={saving} />
            {#if urlProblem(url, { required: true })}
              <p class="text-xs text-destructive" role="alert">{urlProblem(url, { required: true })}</p>
            {/if}
          </div>
          {#key version}
            <ApiKeyField id="station-speech-key-{stationId}" hasApiKey={loaded.hasApiKey} bind:value={apiKey} disabled={saving} />
          {/key}
        </div>
      {/if}
    </details>

    <p class="text-xs text-muted-foreground" data-testid="voice-replies-effective">
      {#if loaded.effective.enabled}
        In effect: {voiceLabel(loaded.effective.voice, voices ?? [])} via {providerName(loaded.effective.url)},
        {SPEAK_MODE_LABELS[loaded.effective.speakMode].toLowerCase()}. {describeSpeechSource(loaded.effective.source)}
      {:else}
        No speech service for this station — replies stay text.
      {/if}
    </p>

    <Button size="sm" onclick={() => void onSave()} disabled={saving || !changed || problem !== null}>
      {saving ? "Saving…" : "Save"}
    </Button>

    {#if harnessMode}
      <div class="space-y-2 border-t border-border pt-3">
        <p class="text-xs text-muted-foreground" data-testid="voice-replies-harness-note">
          This agent runs its own Matrix client and speaks for itself. Save, then apply to write its voice
          into its harness profile.
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
          <p class="text-xs text-muted-foreground" data-testid="voice-replies-apply-result" aria-live="polite">
            {applied.restarted ? "Applied — restarted." : "Applied — restart the gateway to pick it up."}
            {appliedBehaviour(applied)}
          </p>
        {/if}
      </div>
    {/if}
  {/if}
</div>
