<script lang="ts">
  /**
   * The hub's default speech-to-text service for voice notes.
   *
   * Stations inherit it unless they say otherwise (the station page's Voice
   * notes section). Until something is saved here, the hub uses its
   * TRANSCRIBE_* environment — which is why the form says where the current
   * values come from: a form that looks empty on a hub that is transcribing
   * would be a lie.
   */
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import TranscriptionFields from "$lib/components/transcription/TranscriptionFields.svelte";
  import {
    describeSource,
    maxSecondsProblem,
    urlProblem,
  } from "$lib/components/transcription/transcription";
  import {
    getHubTranscription,
    saveHubTranscription,
    testHubTranscription,
    type ApiKeyWrite,
    type HubTranscription,
    type HubTranscriptionInput,
    type TranscriptionTestResult,
  } from "$lib/api/transcription";

  let {
    load = getHubTranscription,
    save = saveHubTranscription,
    testConnection = testHubTranscription,
  }: {
    load?: () => Promise<HubTranscription>;
    save?: (input: HubTranscriptionInput) => Promise<HubTranscription>;
    testConnection?: (input: { url?: string; model?: string; apiKey?: ApiKeyWrite }) => Promise<TranscriptionTestResult>;
  } = $props();

  let loaded = $state<HubTranscription | null>(null);
  let loadError = $state<string | null>(null);
  /** Bumped on every load so the fields re-seed (provider, key state) from it. */
  let version = $state(0);

  let enabled = $state(false);
  let url = $state("");
  let model = $state("");
  let maxSeconds = $state(300);
  let apiKey = $state<ApiKeyWrite>(undefined);

  let saving = $state(false);
  let testing = $state(false);
  let result = $state<TranscriptionTestResult | null>(null);

  function adopt(view: HubTranscription) {
    loaded = view;
    enabled = view.enabled;
    url = view.url;
    model = view.model;
    maxSeconds = view.maxSeconds;
    apiKey = undefined;
    version++;
  }

  onMount(async () => {
    try {
      adopt(await load());
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Couldn’t read the transcription settings.";
    }
  });

  const problem = $derived(urlProblem(url, { required: enabled }) ?? maxSecondsProblem(maxSeconds));

  async function onSave() {
    if (problem !== null || saving) return;
    saving = true;
    try {
      const body: HubTranscriptionInput = { enabled, url: url.trim(), model: model.trim(), maxSeconds };
      if (apiKey !== undefined) body.apiKey = apiKey;
      adopt(await save(body));
      toast.success("Transcription settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn’t save the transcription settings.");
    } finally {
      saving = false;
    }
  }

  async function onTest() {
    if (testing) return;
    testing = true;
    result = null;
    try {
      const body: { url?: string; model?: string; apiKey?: ApiKeyWrite } = {
        url: url.trim(),
        model: model.trim(),
      };
      if (apiKey !== undefined) body.apiKey = apiKey;
      result = await testConnection(body);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : "The test could not be run.", elapsedMs: 0 };
    } finally {
      testing = false;
    }
  }
</script>

<section class="space-y-4" data-testid="hub-transcription">
  <div class="space-y-1">
    <h2 class="text-base font-semibold">Voice notes</h2>
    <p class="text-sm text-muted-foreground">
      Voice notes sent to an agent in a bridged room are transcribed by this service and the agent
      reads the words. Any service with an OpenAI-compatible transcription API works. Stations use this
      unless they set their own.
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
    <p class="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="hub-transcription-source">
      {describeSource(loaded.source)}
    </p>

    <div class="flex items-center gap-3">
      <Switch id="hub-transcription-enabled" bind:checked={enabled} disabled={saving} />
      <Label for="hub-transcription-enabled">Transcribe voice notes</Label>
    </div>

    {#key version}
      <TranscriptionFields
        idPrefix="hub-transcription"
        bind:url
        bind:model
        bind:maxSeconds
        bind:apiKey
        hasApiKey={loaded.hasApiKey}
        urlRequired={enabled}
        disabled={saving}
      />
    {/key}

    <div class="flex flex-wrap items-center gap-2">
      <Button onclick={() => void onSave()} disabled={saving || problem !== null}>
        {saving ? "Saving…" : "Save"}
      </Button>
      <Button
        variant="outline"
        onclick={() => void onTest()}
        disabled={testing || urlProblem(url, { required: true }) !== null}
      >
        {testing ? "Testing…" : "Test connection"}
      </Button>
    </div>

    {#if result}
      <p
        class="text-sm {result.ok ? 'text-status-running' : 'text-destructive'}"
        role="status"
        data-testid="hub-transcription-test-result"
      >
        {#if result.ok}
          Connected — the service answered in {result.elapsedMs} ms.
        {:else}
          Failed{result.status ? ` (HTTP ${result.status})` : ""}: {result.error}
        {/if}
      </p>
    {/if}
  {/if}
</section>
