<script lang="ts">
  import type { Snippet, Component } from "svelte";
  import { cn } from "$lib/utils";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import LockIcon from "@lucide/svelte/icons/lock";

  export interface Tab {
    id: string;
    label: string;
    icon?: Component;
    disabled?: boolean;
    disabledReason?: string;
  }

  type StatusVariant = "running" | "starting" | "stopped" | "error" | "sleeping" | "degraded";

  interface Props {
    title: string;
    icon?: Component;
    subtitle?: string;
    status?: { label: string; variant: StatusVariant; animate?: boolean };
    tabs?: Tab[];
    activeTab?: string;
    onTabChange?: (tabId: string) => void;
    sticky?: boolean;
    actions?: Snippet;
    leading?: Snippet;
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
    leading = undefined,
  }: Props = $props();

  const Icon = $derived(icon);

  const statusText: Record<StatusVariant, string> = {
    running: "text-status-running",
    starting: "text-status-starting",
    stopped: "text-status-stopped",
    error: "text-status-error",
    sleeping: "text-status-sleeping",
    degraded: "text-status-degraded",
  };
  const statusBg: Record<StatusVariant, string> = {
    running: "bg-status-running",
    starting: "bg-status-starting",
    stopped: "bg-status-stopped",
    error: "bg-status-error",
    sleeping: "bg-status-sleeping",
    degraded: "bg-status-degraded",
  };
</script>

<header
  class={cn(
    "z-40 border-b bg-background/90 backdrop-blur-md pt-[env(safe-area-inset-top,0px)]",
    sticky && "sticky top-0",
  )}
>
  <div class="container mx-auto max-w-7xl px-4 sm:px-6">
    <div class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 items-center gap-3">
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
              <span
                class={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium",
                  statusText[status.variant],
                )}
              >
                <span
                  class={cn(
                    "size-1.5 rounded-full",
                    statusBg[status.variant],
                    status.animate && "animate-pulse",
                  )}
                ></span>
                {status.label}
              </span>
            {/if}
          </div>
          {#if subtitle}
            <p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">{subtitle}</p>
          {/if}
        </div>
      </div>
      {#if actions}
        <div class="flex shrink-0 items-center gap-2">
          {@render actions()}
        </div>
      {/if}
    </div>

    {#if tabs.length > 0}
      <div class="scrollbar-hide -mb-px flex gap-1 overflow-x-auto" role="tablist">
        {#each tabs as tab (tab.id)}
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  disabled={tab.disabled}
                  class={cn(
                    "flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                    tab.disabled
                      ? "cursor-not-allowed border-transparent text-muted-foreground/50"
                      : activeTab === tab.id
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                  )}
                  onclick={() => !tab.disabled && onTabChange?.(tab.id)}
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
</header>
