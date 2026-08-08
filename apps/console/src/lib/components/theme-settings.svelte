<script lang="ts">
  import { 
    themeStore, 
    type ThemeMode,
    colorSchemes,
    fontPairings,
    colorSchemeCategories,
    fontPairingCategories
  } from "$lib/themes/store.svelte";
  import { Label } from "$lib/components/ui/label";
  import { Input } from "$lib/components/ui/input";
  import * as Select from "$lib/components/ui/select";
  import * as Tabs from "$lib/components/ui/tabs";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import { cn } from "$lib/utils";
  import { chipClass } from "$lib/utils/toggle-chip";
  import CheckIcon from "@lucide/svelte/icons/check";
  import SunIcon from "@lucide/svelte/icons/sun";
  import MoonIcon from "@lucide/svelte/icons/moon";
  import MonitorIcon from "@lucide/svelte/icons/monitor";
  import SunsetIcon from "@lucide/svelte/icons/sunset";
  import SaveIcon from "@lucide/svelte/icons/save";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import type { ColorSchemeCategory, FontPairingCategory } from "$lib/themes/presets/types";

  // Local state
  let selectedColorCategory = $state<ColorSchemeCategory | "all">("all");
  let selectedFontCategory = $state<FontPairingCategory | "all">("all");
  let customThemeName = $state("");
  let showSaveDialog = $state(false);

  // Delete-confirmation state for saved custom themes
  let deleteDialogOpen = $state(false);
  let pendingDeleteId = $state<string | null>(null);
  let pendingDeleteName = $state("");

  // Filter color schemes by category
  const filteredColorSchemes = $derived(
    selectedColorCategory === "all"
      ? colorSchemes
      : colorSchemes.filter((cs) => cs.category === selectedColorCategory)
  );

  // Filter font pairings by category
  const filteredFontPairings = $derived(
    selectedFontCategory === "all"
      ? fontPairings
      : fontPairings.filter((fp) => fp.category === selectedFontCategory)
  );

  const modeOptions: { value: ThemeMode; label: string; icon: typeof SunIcon }[] = [
    { value: "light", label: "Light", icon: SunIcon },
    { value: "dark", label: "Dark", icon: MoonIcon },
    { value: "system", label: "System", icon: MonitorIcon },
    { value: "auto", label: "Auto", icon: SunsetIcon },
  ];

  function handleModeChange(mode: ThemeMode) {
    themeStore.setMode(mode);
  }

  function handleColorSchemeChange(schemeId: string) {
    themeStore.setColorScheme(schemeId);
  }

  function handleFontPairingChange(pairingId: string) {
    themeStore.setFontPairing(pairingId);
  }

  function handleSaveCustomTheme() {
    if (!customThemeName.trim()) return;
    themeStore.saveCustomTheme(customThemeName.trim());
    customThemeName = "";
    showSaveDialog = false;
  }

  function handleDeleteCustomTheme(id: string, name: string) {
    pendingDeleteId = id;
    pendingDeleteName = name;
    deleteDialogOpen = true;
  }

  function handleConfirmDelete() {
    if (pendingDeleteId) themeStore.deleteCustomTheme(pendingDeleteId);
    deleteDialogOpen = false;
    pendingDeleteId = null;
  }

  function handleCancelDelete() {
    deleteDialogOpen = false;
    pendingDeleteId = null;
  }

  function handleApplyCustomTheme(theme: { id: string; name: string; colorSchemeId: string; fontPairingId: string; createdAt: number; updatedAt: number }) {
    themeStore.applyCustomTheme(theme);
  }

  // Get category labels
  function getColorCategoryLabel(category: string): string {
    return colorSchemeCategories.find((c) => c.id === category)?.label ?? category;
  }

  function getFontCategoryLabel(category: string): string {
    return fontPairingCategories.find((c) => c.id === category)?.label ?? category;
  }
</script>

<div class="space-y-8">
  <!-- Mode Selector -->
  <div class="space-y-3">
    <Label class="text-sm font-medium">Color mode</Label>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {#each modeOptions as option}
        {@const active = themeStore.mode === option.value}
        <button
          type="button"
          onclick={() => handleModeChange(option.value)}
          class={cn(chipClass(active), "flex flex-col items-center gap-2 p-3")}
        >
          <option.icon class="h-5 w-5" />
          <span class="text-xs font-medium">{option.label}</span>
        </button>
      {/each}
    </div>
    <p class="text-xs text-muted-foreground">
      {#if themeStore.mode === "system"}
        Following your system preference ({themeStore.resolvedMode})
      {:else if themeStore.mode === "auto"}
        Dark mode {themeStore.autoSchedule.darkStartHour}:00–{themeStore.autoSchedule.darkEndHour}:00 ({themeStore.resolvedMode} now)
      {:else}
        Using {themeStore.mode} mode
      {/if}
    </p>
  </div>

  <!-- Tabs for Color Scheme and Font Pairing -->
  <Tabs.Root value="colors" class="w-full">
    <Tabs.List class="grid w-full grid-cols-2">
      <Tabs.Trigger value="colors">Color Schemes</Tabs.Trigger>
      <Tabs.Trigger value="fonts">Font Pairings</Tabs.Trigger>
    </Tabs.List>

    <!-- Color Schemes Tab -->
    <Tabs.Content value="colors" class="mt-4 space-y-4">
      <!-- Category Filter -->
      <div class="flex items-center justify-between">
        <Select.Root
          type="single"
          value={selectedColorCategory}
          onValueChange={(v) => {
            if (v) selectedColorCategory = v as ColorSchemeCategory | "all";
          }}
        >
          <Select.Trigger class="w-48">
            {selectedColorCategory === "all" ? "All Categories" : getColorCategoryLabel(selectedColorCategory)}
          </Select.Trigger>
          <Select.Content class="font-mono">
            <Select.Item value="all" label="All Categories" />
            {#each colorSchemeCategories as category}
              <Select.Item value={category.id} label={category.label} />
            {/each}
          </Select.Content>
        </Select.Root>
        <span class="text-xs text-muted-foreground font-mono">
          {filteredColorSchemes.length} schemes
        </span>
      </div>

      <!-- Color Scheme Grid -->
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 max-h-[350px] overflow-y-auto pr-1">
        {#each filteredColorSchemes as scheme}
          {@const isSelected = themeStore.colorSchemeId === scheme.id}
          {@const colors = themeStore.getColorSchemePreview(scheme.id)}
          <button
            type="button"
            onclick={() => handleColorSchemeChange(scheme.id)}
            class="relative flex flex-col rounded border overflow-hidden transition-all
              {isSelected
                ? 'border-primary ring-2 ring-primary'
                : 'border-border/30 hover:border-primary/50'}"
          >
            <!-- Color Preview - show both light and dark -->
            <div class="h-10 w-full flex">
              <div 
                class="flex-1 flex items-center justify-center"
                style="background-color: {scheme.styles.light.background}"
              >
                <div
                  class="h-4 w-4 rounded-full border border-black/20"
                  style="background-color: {scheme.styles.light.primary}"
                ></div>
              </div>
              <div 
                class="flex-1 flex items-center justify-center"
                style="background-color: {scheme.styles.dark.background}"
              >
                <div
                  class="h-4 w-4 rounded-full border border-white/20"
                  style="background-color: {scheme.styles.dark.primary}"
                ></div>
              </div>
            </div>

            <!-- Label -->
            <div class="p-2 text-center bg-background/80 backdrop-blur-sm border-t border-border/30">
              <span class="text-xs font-mono font-medium truncate block">{scheme.label}</span>
            </div>

            <!-- Selected Indicator -->
            {#if isSelected}
              <div class="absolute top-1 right-1 h-5 w-5 rounded-full bg-primary flex items-center justify-center">
                <CheckIcon class="h-3 w-3 text-primary-foreground" />
              </div>
            {/if}
          </button>
        {/each}
      </div>

      <!-- Current Color Scheme Info -->
      {#if themeStore.currentColorScheme}
        {@const currentColors = themeStore.getColorSchemePreview(themeStore.colorSchemeId)}
        <div class="p-3 rounded border border-primary/30 bg-primary/5">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-mono font-medium text-primary">{themeStore.currentColorScheme.label}</p>
              <p class="text-xs text-muted-foreground font-mono capitalize">
                {themeStore.currentColorScheme.category} · Shiki: {themeStore.shikiThemes.light}/{themeStore.shikiThemes.dark}
              </p>
            </div>
            <div class="flex gap-1">
              <div
                class="h-4 w-4 rounded-full border border-white/20"
                style="background-color: {currentColors?.background}"
                title="Background"
              ></div>
              <div
                class="h-4 w-4 rounded-full border border-white/20"
                style="background-color: {currentColors?.primary}"
                title="Primary"
              ></div>
              <div
                class="h-4 w-4 rounded-full border border-white/20"
                style="background-color: {currentColors?.foreground}"
                title="Foreground"
              ></div>
            </div>
          </div>
        </div>
      {/if}
    </Tabs.Content>

    <!-- Font Pairings Tab -->
    <Tabs.Content value="fonts" class="mt-4 space-y-4">
      <!-- Category Filter -->
      <div class="flex items-center justify-between">
        <Select.Root
          type="single"
          value={selectedFontCategory}
          onValueChange={(v) => {
            if (v) selectedFontCategory = v as FontPairingCategory | "all";
          }}
        >
          <Select.Trigger class="w-48">
            {selectedFontCategory === "all" ? "All Categories" : getFontCategoryLabel(selectedFontCategory)}
          </Select.Trigger>
          <Select.Content class="font-mono">
            <Select.Item value="all" label="All Categories" />
            {#each fontPairingCategories as category}
              <Select.Item value={category.id} label={category.label} />
            {/each}
          </Select.Content>
        </Select.Root>
        <span class="text-xs text-muted-foreground font-mono">
          {filteredFontPairings.length} pairings
        </span>
      </div>

      <!-- Font Pairing Grid -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[350px] overflow-y-auto pr-1">
        {#each filteredFontPairings as pairing}
          {@const isSelected = themeStore.fontPairingId === pairing.id}
          <button
            type="button"
            onclick={() => handleFontPairingChange(pairing.id)}
            class="relative p-4 rounded border text-left transition-all
              {isSelected
                ? 'border-primary ring-2 ring-primary bg-primary/5'
                : 'border-border/30 hover:border-primary/50 bg-background/50'}"
          >
            <!-- Font Preview -->
            <div class="space-y-2">
              <p 
                class="text-lg font-semibold truncate" 
                style="font-family: '{pairing.fonts['font-heading']}', sans-serif"
              >
                {pairing.label}
              </p>
              <p 
                class="text-sm text-muted-foreground" 
                style="font-family: '{pairing.fonts['font-body']}', sans-serif"
              >
                {pairing.description}
              </p>
              <p 
                class="text-xs text-muted-foreground/70 font-mono" 
                style="font-family: '{pairing.fonts['font-mono']}', monospace"
              >
                const code = "monospace";
              </p>
            </div>

            <!-- Font Names -->
            <div class="mt-3 pt-3 border-t border-border/30 flex flex-wrap gap-2">
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-muted font-mono">
                {pairing.fonts["font-body"]}
              </span>
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-muted font-mono">
                {pairing.fonts["font-heading"]}
              </span>
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-muted font-mono">
                {pairing.fonts["font-mono"]}
              </span>
            </div>

            <!-- Selected Indicator -->
            {#if isSelected}
              <div class="absolute top-2 right-2 h-5 w-5 rounded-full bg-primary flex items-center justify-center">
                <CheckIcon class="h-3 w-3 text-primary-foreground" />
              </div>
            {/if}
          </button>
        {/each}
      </div>

      <!-- Current Font Pairing Info -->
      {#if themeStore.currentFontPairing}
        <div class="p-3 rounded border border-primary/30 bg-primary/5">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-mono font-medium text-primary">{themeStore.currentFontPairing.label}</p>
              <p class="text-xs text-muted-foreground font-mono capitalize">
                {themeStore.currentFontPairing.category}
              </p>
            </div>
            <div class="text-xs text-muted-foreground font-mono text-right">
              <p>Body: {themeStore.currentFontPairing.fonts["font-body"]}</p>
              <p>Heading: {themeStore.currentFontPairing.fonts["font-heading"]}</p>
              <p>Mono: {themeStore.currentFontPairing.fonts["font-mono"]}</p>
            </div>
          </div>
        </div>
      {/if}
    </Tabs.Content>
  </Tabs.Root>

  <!-- Saved Custom Themes -->
  {#if themeStore.customThemes.length > 0}
    <div class="space-y-3">
      <Label class="text-sm font-medium">Saved combinations</Label>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {#each themeStore.customThemes as customTheme}
          <div class="flex items-center justify-between p-3 rounded border border-border/30 bg-background/50 hover:border-primary/30 transition-colors">
            <button
              type="button"
              onclick={() => handleApplyCustomTheme(customTheme)}
              class="flex-1 text-left"
            >
              <p class="text-sm font-medium">{customTheme.name}</p>
              <p class="text-xs text-muted-foreground font-mono">
                {customTheme.colorSchemeId} + {customTheme.fontPairingId}
              </p>
            </button>
            <Button
              variant="ghost"
              size="icon"
              onclick={() => handleDeleteCustomTheme(customTheme.id, customTheme.name)}
              class="h-8 w-8 text-muted-foreground hover:text-destructive"
              data-testid="delete-theme-{customTheme.id}"
              aria-label="Delete theme {customTheme.name}"
            >
              <Trash2Icon class="h-4 w-4" />
            </Button>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <ConfirmDialog
    open={deleteDialogOpen}
    title="Delete theme"
    message={`Delete "${pendingDeleteName}"? This can't be undone.`}
    confirmLabel="Delete"
    destructive
    onConfirm={handleConfirmDelete}
    onCancel={handleCancelDelete}
  />

  <!-- Save Current Combination -->
  <div class="space-y-3">
    <Label class="text-sm font-medium">Save current combination</Label>
    {#if showSaveDialog}
      <div class="flex items-center gap-2">
        <Input
          bind:value={customThemeName}
          placeholder="My custom theme..."
          class="flex-1"
        />
        <Button onclick={handleSaveCustomTheme} disabled={!customThemeName.trim()}>
          Save
        </Button>
        <Button
          variant="outline"
          onclick={() => { showSaveDialog = false; customThemeName = ""; }}
        >
          Cancel
        </Button>
      </div>
    {:else}
      <Button variant="outline" onclick={() => showSaveDialog = true} class="w-full">
        <SaveIcon class="h-4 w-4 mr-2" />
        Save "{themeStore.currentColorScheme?.label}" + "{themeStore.currentFontPairing?.label}"
      </Button>
    {/if}
    <p class="text-xs text-muted-foreground">
      Mix and match any color scheme with any font pairing. Save your favorite combinations for quick access.
    </p>
  </div>
</div>
