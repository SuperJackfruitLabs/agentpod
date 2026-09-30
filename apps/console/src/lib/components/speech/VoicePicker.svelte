<script lang="ts">
  /**
   * Pick a voice: the speech service's voices grouped US/UK, female/male, best
   * grade first, each with its grade; a "Custom or blend…" entry that takes a
   * typed id or a blend (`af_heart:60+af_bella:40`); and a button that plays
   * the chosen voice's sample.
   *
   * `value` "" means "not chosen here" — what that falls back to is the
   * `emptyLabel` (the hub default, or the station's assigned voice), and
   * `fallbackVoice` is what the preview plays for it.
   *
   * A native `<select>`: keyboard, screen readers and the phone's own picker
   * all work without help, and optgroups carry the grouping.
   */
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { fetchVoicePreview, type VoiceInfo } from "$lib/api/speech";
  import { groupVoices, playAudio, voiceLabel, voiceProblem } from "./speech";

  const CUSTOM = "__custom__";

  let {
    id,
    label = "Voice",
    value = $bindable(""),
    voices,
    voicesError = null,
    emptyLabel,
    fallbackVoice = "",
    disabled = false,
    preview = fetchVoicePreview,
    play = playAudio,
  }: {
    id: string;
    label?: string;
    value?: string;
    /** null while loading. */
    voices: VoiceInfo[] | null;
    voicesError?: string | null;
    emptyLabel: string;
    fallbackVoice?: string;
    disabled?: boolean;
    preview?: (voiceId: string) => Promise<Blob>;
    play?: (audio: Blob) => unknown;
  } = $props();

  const known = $derived(new Set((voices ?? []).map((v) => v.id)));
  let customMode = $state(false);
  const selected = $derived(value === "" && !customMode ? "" : known.has(value) && !customMode ? value : CUSTOM);
  const showCustom = $derived(selected === CUSTOM || (voices !== null && voices.length === 0));
  const problem = $derived(voiceProblem(value));
  const groups = $derived(groupVoices(voices ?? []));

  /** The voice the preview button plays: the chosen one, else what "" falls back to. */
  const previewId = $derived(value !== "" ? value : fallbackVoice);
  const previewable = $derived(known.has(previewId));

  let playing = $state(false);
  let previewError = $state<string | null>(null);

  function onSelect(e: Event) {
    const next = (e.currentTarget as HTMLSelectElement).value;
    if (next === CUSTOM) {
      customMode = true;
      return;
    }
    customMode = false;
    value = next;
  }

  async function onPreview() {
    if (!previewable || playing) return;
    playing = true;
    previewError = null;
    try {
      play(await preview(previewId));
    } catch (e) {
      previewError = e instanceof Error ? e.message : "The preview could not be played.";
    } finally {
      playing = false;
    }
  }
</script>

<div class="space-y-1.5" data-testid="voice-picker">
  <Label for={id}>{label}</Label>
  <div class="flex items-center gap-2">
    <select
      {id}
      class="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
      value={selected}
      onchange={onSelect}
      {disabled}
    >
      <option value="">{emptyLabel}</option>
      {#each groups as group (group.label)}
        <optgroup label={group.label}>
          {#each group.voices as v (v.id)}
            <option value={v.id}>{v.name} · {v.grade}</option>
          {/each}
        </optgroup>
      {/each}
      <option value={CUSTOM}>Custom or blend…</option>
    </select>
    <Button
      type="button"
      variant="outline"
      size="sm"
      onclick={() => void onPreview()}
      disabled={disabled || !previewable || playing}
      aria-label={previewable ? `Play a sample of ${voiceLabel(previewId, voices ?? [])}` : "No sample for this voice"}
      title={previewable ? undefined : "Samples are for single voices, not blends"}
    >
      {playing ? "Loading…" : "Play"}
    </Button>
  </div>

  {#if showCustom}
    <Input
      id="{id}-custom"
      aria-label="Voice id or blend"
      placeholder="af_heart:60+af_bella:40"
      spellcheck={false}
      autocomplete="off"
      bind:value
      {disabled}
      aria-invalid={problem !== null}
    />
    {#if problem}
      <p class="text-xs text-destructive" role="alert">{problem}</p>
    {:else}
      <p class="text-xs text-muted-foreground">A voice id, or up to four blended with weights.</p>
    {/if}
  {/if}

  {#if voicesError}
    <p class="text-xs text-muted-foreground" data-testid="voice-list-error">
      The voice list is unavailable ({voicesError}); a voice id can still be typed.
    </p>
  {/if}
  {#if previewError}
    <p class="text-xs text-destructive" role="alert">{previewError}</p>
  {/if}
</div>
