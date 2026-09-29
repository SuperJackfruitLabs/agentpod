<script lang="ts">
  /**
   * The hub's default text-to-speech service for agents' spoken replies.
   *
   * Stations inherit it unless they say otherwise (the station page's Voice
   * replies section). Until something is saved here the hub uses its SPEECH_*
   * environment, so the form says where the current values come from.
   *
   * "Default voice" left as "Each agent its own voice" means every agent is
   * assigned one from its id — a fleet that does not all sound alike.
   */
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import ApiKeyField from "$lib/components/transcription/ApiKeyField.svelte";
  import VoicePicker from "$lib/components/speech/VoicePicker.svelte";
  import { urlProblem } from "$lib/components/transcription/transcription";
  import {
    describeSpeechSource,
    maxCharsProblem,
    playAudio,
    SPEAK_MODE_LABELS,
    voiceProblem,
  } from "$lib/components/speech/speech";
  import {
    getHubSpeech,
    listVoices,
    saveHubSpeech,
    testHubSpeech,
    type ApiKeyWrite,
    type HubSpeech,
    type HubSpeechInput,
    type SpeakMode,
    type SpeechTestResult,
    type VoiceInfo,
    type VoiceList,
  } from "$lib/api/speech";

  let {
    load = getHubSpeech,
    save = saveHubSpeech,
    testConnection = testHubSpeech,
    loadVoices = listVoices,
    play = playAudio,
    preview,
  }: {
    load?: () => Promise<HubSpeech>;
    save?: (input: HubSpeechInput) => Promise<HubSpeech>;
    testConnection?: (input: { url?: string; apiKey?: ApiKeyWrite; voice?: string }) => Promise<SpeechTestResult>;
    loadVoices?: () => Promise<VoiceList>;
    /** Plays the test clip (base64 Ogg) or a preview. */
    play?: (audio: Blob | string) => unknown;
    preview?: (voiceId: string) => Promise<Blob>;
  } = $props();

  let loaded = $state<HubSpeech | null>(null);
  let loadError = $state<string | null>(null);
  let version = $state(0);

  let enabled = $state(false);
  let url = $state("");
  let defaultVoice = $state("");
  let mode = $state<SpeakMode>("voice_in");
  let maxChars = $state(1500);
  let apiKey = $state<ApiKeyWrite>(undefined);

  let voices = $state<VoiceInfo[] | null>(null);
  let voicesError = $state<string | null>(null);

  let saving = $state(false);
  let testing = $state(false);
  let result = $state<SpeechTestResult | null>(null);

  function adopt(view: HubSpeech) {
    loaded = view;
    enabled = view.enabled;
    url = view.url;
    defaultVoice = view.defaultVoice;
    mode = view.mode;
    maxChars = view.maxChars;
    apiKey = undefined;
    version++;
  }

  async function refreshVoices() {
    try {
      voices = (await loadVoices()).voices;
      voicesError = null;
    } catch (e) {
      voices = [];
      voicesError = e instanceof Error ? e.message : "no answer";
    }
  }

  onMount(async () => {
    try {
      adopt(await load());
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Couldn’t read the speech settings.";
      return;
    }
    await refreshVoices();
  });

  const problem = $derived(
    urlProblem(url, { required: enabled }) ?? maxCharsProblem(maxChars) ?? voiceProblem(defaultVoice)
  );

  async function onSave() {
    if (problem !== null || saving) return;
    saving = true;
    try {
      const body: HubSpeechInput = { enabled, url: url.trim(), defaultVoice: defaultVoice.trim(), mode, maxChars };
      if (apiKey !== undefined) body.apiKey = apiKey;
      adopt(await save(body));
      toast.success("Speech settings saved");
      await refreshVoices();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn’t save the speech settings.");
    } finally {
      saving = false;
    }
  }

  async function onTest() {
    if (testing) return;
    testing = true;
    result = null;
    try {
      const body: { url?: string; apiKey?: ApiKeyWrite; voice?: string } = { url: url.trim() };
      if (apiKey !== undefined) body.apiKey = apiKey;
      if (defaultVoice.trim() !== "" && voiceProblem(defaultVoice) === null) body.voice = defaultVoice.trim();
      result = await testConnection(body);
      if (result.ok && result.audio) play(result.audio);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : "The test could not be run.", elapsedMs: 0 };
    } finally {
      testing = false;
    }
  }

  const MODES: SpeakMode[] = ["voice_in", "always", "off"];
</script>

<section class="space-y-4" data-testid="hub-speech">
  <div class="space-y-1">
    <h2 class="text-base font-semibold">Voice replies</h2>
    <p class="text-sm text-muted-foreground">
      Agents the hub speaks for (Claude Code, Codex, opencode, Pi and other bridged agents) can answer
      with a voice note after their text. Any service with an OpenAI-compatible speech API works;
      AgentPod's own (deploy/speech) also draws the waveform. Stations use this unless they set their own.
    </p>
  </div>

  {#if loadError}
    <p class="text-sm text-destructive" role="alert">{loadError}</p>
  {:else if loaded === null}
    <div class="space-y-2">
      <Skeleton class="h-8 w-full" />
      <Skeleton class="h-8 w-full" />
      <Skeleton class="h-8 w-2/3" />
    </div>
  {:else}
    <p class="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="hub-speech-source">
      {describeSpeechSource(loaded.source)}
    </p>

    <div class="flex items-center gap-3">
      <Switch id="hub-speech-enabled" bind:checked={enabled} disabled={saving} />
      <Label for="hub-speech-enabled">Speak replies</Label>
    </div>

    <div class="space-y-1.5">
      <Label for="hub-speech-url">Service URL</Label>
      <Input
        id="hub-speech-url"
        placeholder="http://100.78.52.87:8841"
        spellcheck={false}
        autocomplete="off"
        bind:value={url}
        disabled={saving}
        aria-invalid={urlProblem(url, { required: enabled }) !== null}
      />
      {#if urlProblem(url, { required: enabled })}
        <p class="text-xs text-destructive" role="alert">{urlProblem(url, { required: enabled })}</p>
      {/if}
    </div>

    {#key version}
      <ApiKeyField id="hub-speech-key" hasApiKey={loaded.hasApiKey} bind:value={apiKey} disabled={saving} />
    {/key}

    <VoicePicker
      id="hub-speech-voice"
      label="Default voice"
      bind:value={defaultVoice}
      {voices}
      {voicesError}
      emptyLabel="Each agent its own voice"
      disabled={saving}
      play={play}
      {...preview ? { preview } : {}}
    />

    <fieldset class="space-y-1.5" disabled={saving}>
      <legend class="text-sm font-medium">When agents speak</legend>
      {#each MODES as m (m)}
        <label class="flex items-center gap-2 text-sm">
          <input type="radio" name="hub-speech-mode" value={m} bind:group={mode} />
          <span>{SPEAK_MODE_LABELS[m]}</span>
        </label>
      {/each}
    </fieldset>

    <div class="space-y-1.5">
      <Label for="hub-speech-max-chars">Longest reply spoken (characters)</Label>
      <Input id="hub-speech-max-chars" type="number" min="100" max="4096" step="1" bind:value={maxChars} disabled={saving} />
      <p class="text-xs text-muted-foreground">
        Longer replies are spoken up to the last full sentence within this; the text has the rest.
      </p>
      {#if maxCharsProblem(maxChars)}
        <p class="text-xs text-destructive" role="alert">{maxCharsProblem(maxChars)}</p>
      {/if}
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <Button onclick={() => void onSave()} disabled={saving || problem !== null}>
        {saving ? "Saving…" : "Save"}
      </Button>
      <Button
        variant="outline"
        onclick={() => void onTest()}
        disabled={testing || urlProblem(url, { required: true }) !== null}
      >
        {testing ? "Testing…" : "Test and play"}
      </Button>
    </div>

    {#if result}
      <p
        class="text-sm {result.ok ? 'text-status-running' : 'text-destructive'}"
        role="status"
        data-testid="hub-speech-test-result"
      >
        {#if result.ok}
          Spoke {result.durationMs !== undefined ? `${(result.durationMs / 1000).toFixed(1)} s of audio` : "a sentence"}
          in {result.elapsedMs} ms.
        {:else}
          Failed{result.status ? ` (HTTP ${result.status})` : ""}: {result.error}
        {/if}
      </p>
    {/if}
  {/if}
</section>
