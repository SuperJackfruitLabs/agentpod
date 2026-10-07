<script lang="ts">
  import type { Snippet, Component } from "svelte";
  import { cn } from "$lib/utils";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import { Status } from "$lib/components/ui/status";
  import LockIcon from "@lucide/svelte/icons/lock";
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import { MediaQuery } from "svelte/reactivity";
  import { Button } from "$lib/components/ui/button";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { scrollStrip } from "$lib/actions/scroll-strip";

  export interface Tab {
    id: string;
    label: string;
    icon?: Component;
    disabled?: boolean;
    disabledReason?: string;
  }

  /**
   * An action that matters less than the page's primary one. Inline outline
   * buttons on a wide screen; on a phone they fold into one "More actions"
   * menu, because three buttons wrapped the sticky header to 19% of a 390px
   * screen (responsive audit, 2026-10-07).
   */
  export interface SecondaryAction {
    label: string;
    icon?: Component;
    onSelect: () => void;
    disabled?: boolean;
  }

  // Any raw status string — normalized by the shared <Status> component.

  interface Props {
    title: string;
    icon?: Component;
    subtitle?: string;
    status?: { label: string; variant: string; animate?: boolean };
    tabs?: Tab[];
    activeTab?: string;
    onTabChange?: (tabId: string) => void;
    sticky?: boolean;
    actions?: Snippet;
    /** Folded into an overflow menu below 640px. Rendered before `actions`. */
    secondaryActions?: SecondaryAction[];
    leading?: Snippet;
    /** Signature status strip rendered flush under the header border
     *  (pass a 3px `<StatusRibbon size="xs">` scoped to this page). */
    ribbon?: Snippet;
    tabsId?: string;
  }

  let {
    title,
    icon = undefined,
    subtitle = undefined,
    status = undefined,
    tabs = [],
    activeTab = "",
    onTabChange = undefined,
    sticky = true,
    actions = undefined,
    secondaryActions = [],
    leading = undefined,
    ribbon = undefined,
    tabsId = "page-tabs",
  }: Props = $props();

  const Icon = $derived(icon);

  // The same 640px as Tailwind's `sm`, asked in JS so exactly one copy of each
  // action exists: CSS-hiding a second copy would leave it in the a11y tree.
  const phone = new MediaQuery("(max-width: 639px)");

  let tabRefs = $state<(HTMLButtonElement | null)[]>([]);

  function activateTab(tab: Tab) {
    if (tab.disabled) return;
    onTabChange?.(tab.id);
  }

  function focusTabAt(index: number) {
    const count = tabs.length;
    if (count === 0) return;
    const wrapped = ((index % count) + count) % count;
    tabRefs[wrapped]?.focus();
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
        const target = event.target as HTMLElement;
        const index = tabRefs.findIndex((el) => el === target);
        if (index >= 0) {
          event.preventDefault();
          activateTab(tabs[index]);
        }
        break;
      }
    }
  }

</script>

<header
  class={cn(
    "z-40 border-b bg-background/90 backdrop-blur-md pt-[env(safe-area-inset-top,0px)]",
    sticky && "sticky top-0",
  )}
>
  <div class="page-width">
    <!-- One row at every width: title on the left, actions on the right.
         It wraps only if the actions truly cannot fit beside the title. -->
    <div data-testid="page-header-row" class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3 sm:py-4">
      <!-- An 8rem basis, not the title's full width: the row wraps only when
           the actions would leave the title less than that, and otherwise the
           subtitle truncates beside them. -->
      <div class="flex min-w-0 flex-[1_1_8rem] items-center gap-3">
        {#if leading}
          {@render leading()}
          <div class="hidden h-6 w-px bg-border sm:block"></div>
        {/if}
        {#if Icon}
          <Icon class="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {/if}
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2.5 overflow-hidden">
            <h1 class="truncate text-lg font-semibold tracking-tight">{title}</h1>
            {#if status}
              <Status form="badge" status={status.variant} label={status.label} />
            {/if}
          </div>
          {#if subtitle}
            <!-- Sans, not mono: this is prose. Mono is for strings a machine minted
                 and a person must compare character by character — handles, station
                 keys, ids, versions. Setting "Fleet event log" in it is what made
                 every page header read like a config file. -->
            <p class="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
          {/if}
        </div>
      </div>
      {#if actions || secondaryActions.length > 0}
        <div class="ml-auto flex shrink-0 items-center gap-2">
          {#if secondaryActions.length > 0}
            {#if phone.current}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <Button {...props} variant="outline" size="icon" class="size-11" aria-label="More actions">
                      <EllipsisIcon class="h-4 w-4" aria-hidden="true" />
                    </Button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end" class="min-w-52">
                  {#each secondaryActions as action (action.label)}
                    {@const ActionIcon = action.icon}
                    <DropdownMenu.Item class="min-h-11" disabled={action.disabled} onSelect={action.onSelect}>
                      {#if ActionIcon}<ActionIcon class="h-4 w-4" aria-hidden="true" />{/if}
                      {action.label}
                    </DropdownMenu.Item>
                  {/each}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            {:else}
              {#each secondaryActions as action (action.label)}
                {@const ActionIcon = action.icon}
                <Button variant="outline" disabled={action.disabled} onclick={action.onSelect}>
                  {#if ActionIcon}<ActionIcon class="h-4 w-4 mr-2" aria-hidden="true" />{/if}
                  {action.label}
                </Button>
              {/each}
            {/if}
          {/if}
          {@render actions?.()}
        </div>
      {/if}
    </div>

    {#if tabs.length > 0}
      <!-- svelte-ignore a11y_interactive_supports_focus -- roving tabindex lives on the individual tab buttons, not the tablist container -->
      <div
        class="scroll-strip -mb-px flex min-w-0 gap-1"
        role="tablist"
        onkeydown={handleTablistKeydown}
        use:scrollStrip={activeTab}
      >
        {#each tabs as tab, i (tab.id)}
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  bind:this={tabRefs[i]}
                  type="button"
                  role="tab"
                  id="{tabsId}-tab-{tab.id}"
                  aria-controls="{tabsId}-panel-{tab.id}"
                  aria-selected={activeTab === tab.id}
                  aria-disabled={tab.disabled ? "true" : undefined}
                  aria-label={tab.label}
                  tabindex={activeTab === tab.id ? 0 : -1}
                  class={cn(
                    "flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors max-[900px]:min-h-11 pointer-coarse:min-h-11",
                    tab.disabled
                      ? "cursor-not-allowed border-transparent text-muted-foreground/50"
                      : activeTab === tab.id
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                  )}
                  onclick={() => activateTab(tab)}
                >
                  {#if tab.disabled}
                    <LockIcon class="h-3.5 w-3.5" aria-hidden="true" />
                  {:else if tab.icon}
                    {@const TabIcon = tab.icon}
                    <TabIcon class="h-4 w-4" aria-hidden="true" />
                  {/if}
                  <span class="hidden sm:inline">{tab.label}</span>
                </button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content class={tab.disabled ? "" : "sm:hidden"}>
              <p>{tab.disabled && tab.disabledReason ? tab.disabledReason : tab.label}</p>
            </Tooltip.Content>
          </Tooltip.Root>
        {/each}
      </div>
    {/if}
  </div>
  {#if ribbon}
    <!-- The fleet, as chrome: a full-bleed 3px strip flush against the border -->
    {@render ribbon()}
  {/if}
</header>
