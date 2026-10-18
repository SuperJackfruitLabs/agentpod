<script lang="ts">
  /**
   * AppearanceControl — vibe, Light / Dark / Follow the sun, and accent, as the account menu,
   * the phone's More sheet and Settings draw it (AP2-Settings mockups). Every choice is written
   * at once (cookie + <html> attributes) by the appearance store. No time-of-day control: the
   * vibe's own default strength stands.
   */
  import type { AccentChoice, ThemePreference, Vibe } from "@superjackfruit/vibekit";
  import { appearance } from "$lib/appearance.svelte";

  let { idPrefix = "appearance" }: { idPrefix?: string } = $props();

  const VIBES: { id: Vibe; label: string }[] = [
    { id: "daylight", label: "Daylight" },
    { id: "paper", label: "Paper" },
    { id: "studio", label: "Studio" },
    { id: "quiet", label: "Quiet" },
  ];
  const THEMES: { id: ThemePreference; label: string }[] = [
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
    { id: "sun", label: "Follow the sun" },
  ];
  const ACCENTS: { id: AccentChoice; label: string; hint: string; swatch: string }[] = [
    { id: "product", label: "Cobalt, product default", hint: "Cobalt (product default)", swatch: "agentpod" },
    { id: "gold", label: "Superpipeline colour", hint: "Gold (Superpipeline colour)", swatch: "superpipeline" },
    { id: "plum", label: "Superlibrary colour", hint: "Plum (Superlibrary colour)", swatch: "superlibrary" },
    { id: "jade", label: "Superwitness colour", hint: "Jade (Superwitness colour)", swatch: "superwitness" },
  ];

  const accentHint = $derived(ACCENTS.find((a) => a.id === appearance.accent)?.hint ?? "");
</script>

<div class="ap-appear" data-testid="appearance-control">
  <fieldset>
    <legend id="{idPrefix}-vibe">Vibe</legend>
    <div class="ap-appear__segs">
      {#each VIBES as v (v.id)}
        <button
          type="button"
          class="ap-appear__seg"
          aria-pressed={appearance.value.vibe === v.id}
          onclick={() => appearance.set({ vibe: v.id })}
        >{v.label}</button>
      {/each}
    </div>
  </fieldset>
  <fieldset>
    <legend>Light or dark</legend>
    <div class="ap-appear__segs ap-appear__segs--3">
      {#each THEMES as t (t.id)}
        <button
          type="button"
          class="ap-appear__seg"
          aria-pressed={appearance.value.theme === t.id}
          onclick={() => appearance.set({ theme: t.id })}
        >{t.label}</button>
      {/each}
    </div>
  </fieldset>
  <fieldset>
    <legend>Accent</legend>
    <div class="ap-appear__swatches">
      {#each ACCENTS as a (a.id)}
        <button
          type="button"
          class="ap-appear__swatch"
          aria-pressed={appearance.accent === a.id}
          aria-label={a.label}
          title={a.label}
          style="background: {a.id === 'product' && appearance.accent === 'product' ? 'var(--vk-color-accent)' : `var(--vk-product-${a.swatch}-bg)`}"
          onclick={() => appearance.setAccent(a.id)}
        ></button>
      {/each}
    </div>
    <p class="ap-appear__hint">{accentHint}</p>
  </fieldset>
</div>
