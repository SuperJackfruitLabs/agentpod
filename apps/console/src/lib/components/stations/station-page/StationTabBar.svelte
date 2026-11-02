<script lang="ts">
  /**
   * The station page's tab strip. Roving tabindex: only the selected tab is in the tab order,
   * arrows move focus between them (WAI-ARIA tabs pattern).
   */
  import { scrollStrip } from "$lib/actions/scroll-strip";
  import { cn } from "$lib/utils";
  import LockIcon from "@lucide/svelte/icons/lock";
  import type { Tab, TabDef } from "./tabs";

  interface Props {
    tabs: TabDef[];
    activeTab: Tab;
    /** Base id the tab buttons and the tabpanels build their ids from. */
    tabsId: string;
    onSelect: (tab: Tab) => void;
  }

  let { tabs, activeTab, tabsId, onSelect }: Props = $props();

  let tabRefs = $state<(HTMLButtonElement | null)[]>([]);

  function focusTabAt(index: number) {
    const count = tabs.length;
    if (count === 0) return;
    tabRefs[((index % count) + count) % count]?.focus();
  }

  function handleTablistKeydown(event: KeyboardEvent) {
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTab);
    const focusedIndex = tabRefs.findIndex((el) => el === document.activeElement);
    const fromIndex = focusedIndex >= 0 ? focusedIndex : Math.max(currentIndex, 0);

    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        focusTabAt(fromIndex + 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        focusTabAt(fromIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        focusTabAt(0);
        break;
      case "End":
        event.preventDefault();
        focusTabAt(tabs.length - 1);
        break;
      case "Enter":
      case " ": {
        const index = tabRefs.findIndex((el) => el === (event.target as HTMLElement));
        if (index >= 0 && !tabs[index].disabled) {
          event.preventDefault();
          onSelect(tabs[index].id);
        }
        break;
      }
    }
  }
</script>

<!-- svelte-ignore a11y_interactive_supports_focus -- the roving tabindex lives on the tab buttons, not the tablist -->
<div
  class="ap-st-tabs scroll-strip flex min-w-0 gap-1 px-4 sm:px-6"
  role="tablist"
  onkeydown={handleTablistKeydown}
  use:scrollStrip={`${activeTab}:${tabs.length}`}
>
  {#each tabs as tab, i (tab.id)}
    {@const TabIcon = tab.icon}
    <button
      bind:this={tabRefs[i]}
      type="button"
      role="tab"
      id="{tabsId}-tab-{tab.id}"
      aria-controls="{tabsId}-panel-{tab.id}"
      aria-selected={activeTab === tab.id}
      aria-disabled={tab.disabled ? "true" : undefined}
      aria-label={tab.label}
      title={tab.disabled ? tab.disabledReason : tab.label}
      tabindex={activeTab === tab.id ? 0 : -1}
      class={cn(
        "flex shrink-0 items-center gap-2 border-b-2 px-2.5 py-2 text-sm whitespace-nowrap transition-colors touch:min-h-11",
        tab.disabled
          ? "cursor-not-allowed border-transparent text-muted-foreground/50"
          : activeTab === tab.id
            ? "border-foreground font-medium text-foreground"
            : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
      )}
      onclick={() => !tab.disabled && onSelect(tab.id)}
    >
      {#if tab.disabled}
        <LockIcon class="h-3.5 w-3.5" aria-hidden="true" />
      {:else}
        <TabIcon class="h-4 w-4" aria-hidden="true" />
      {/if}
      {tab.label}
    </button>
  {/each}
</div>
