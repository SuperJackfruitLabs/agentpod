<script lang="ts">
  import { onMount } from "svelte";
  import type { Snippet } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import HealthPanel from "$lib/components/stations/HealthPanel.svelte";
  import LogTail from "$lib/components/stations/LogTail.svelte";
  import FileBrowser from "$lib/components/stations/FileBrowser.svelte";
  import ConfigEditor from "$lib/components/stations/ConfigEditor.svelte";
  import Terminal from "$lib/components/stations/Terminal.svelte";
  import ChatPanel from "$lib/components/stations/chat/ChatPanel.svelte";
  import CleanupPanel from "$lib/components/stations/CleanupPanel.svelte";
  import ActivityPanel from "$lib/components/stations/ActivityPanel.svelte";
  import { listStations } from "$lib/api/client";
  import type { StationRow } from "$lib/api/client";
  import PageHeader from "$lib/components/page-header.svelte";
  import { Button } from "$lib/components/ui/button";
  import HarnessBadge from "$lib/components/fleet/HarnessBadge.svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import HeartPulseIcon from "@lucide/svelte/icons/heart-pulse";
  import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
  import FolderIcon from "@lucide/svelte/icons/folder";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import MessageSquareIcon from "@lucide/svelte/icons/message-square";

  const nodeId = $derived($page.params.id as string);
  const stationId = $derived($page.params.stationId as string);

  type Tab = "chat" | "health" | "logs" | "files" | "terminal" | "cleanup" | "activity";
  const VALID_TABS: readonly Tab[] = [
    "chat",
    "health",
    "logs",
    "files",
    "terminal",
    "cleanup",
    "activity",
  ];

  // The active tab lives in the URL (?tab=logs) so station views are
  // deep-linkable, survive refresh, and participate in back/forward.
  // An absent or unknown param falls back to the station's default tab: talking
  // to the agent is the point of an ACP-capable station, so chat leads there and
  // health leads everywhere else.
  const activeTab = $derived.by<Tab>(() => {
    const t = $page.url.searchParams?.get("tab");
    return VALID_TABS.includes(t as Tab) ? (t as Tab) : defaultTab;
  });

  /** Base id PageHeader builds its tab/panel ids from — kept in one place so
   *  the tablist's aria-controls and the tabpanels' ids/aria-labelledby
   *  can't drift apart. */
  const tabsId = "page-tabs";

  /** Heavy tabs (SSE stream / file tree / terminal session) the user has
   *  switched to at least once — kept mounted after that so tab switches no
   *  longer drop the log stream, tree state, or terminal scrollback. Health/
   *  cleanup/activity intentionally stay plain if-mounted below: they fetch
   *  fresh data on every mount (e.g. Activity's onMount fetch), and keeping
   *  them alive would make that data go stale while the tab is hidden. */
  let visitedHeavyTabs = $state(new Set<Tab>());
  $effect(() => {
    if (
      (activeTab === "chat" ||
        activeTab === "logs" ||
        activeTab === "files" ||
        activeTab === "terminal") &&
      !visitedHeavyTabs.has(activeTab)
    ) {
      visitedHeavyTabs = new Set(visitedHeavyTabs).add(activeTab);
    }
  });

  let station = $state<StationRow | null>(null);
  let stationLoad = $state<"loading" | "loaded" | "notFound" | "error">("loading");
  let stationLoadError = $state<string | null>(null);

  /** Path of the file currently open in the ConfigEditor modal, or null. */
  let configEditorPath = $state<string | null>(null);

  /** Instance ref so ConfigEditor's onSaved can evict FileBrowser's stale
   *  content cache for the saved path (see FileBrowser.invalidate). */
  let fileBrowser: FileBrowser | undefined = $state();
  let configEditor: ConfigEditor | undefined = $state();

  const hasAcp = $derived(
    Array.isArray(station?.capabilities) && station!.capabilities.includes("acp")
  );

  /** Tab shown when ?tab= is absent — also the one whose selection DELETES the param. */
  const defaultTab = $derived<Tab>(hasAcp ? "chat" : "health");

  const hasTerminal = $derived(
    Array.isArray(station?.capabilities) && station!.capabilities.includes("terminal")
  );

  const canWrite = $derived(
    Array.isArray(station?.capabilities) && station!.capabilities.includes("fs.write")
  );

  const canLifecycle = $derived(
    Array.isArray(station?.capabilities) && station!.capabilities.includes("lifecycle")
  );

  const hasCleanup = $derived(
    Array.isArray(station?.capabilities) && station!.capabilities.includes("cleanup")
  );

  async function loadStation() {
    stationLoad = "loading";
    stationLoadError = null;
    try {
      const rows = await listStations(nodeId);
      station = rows.find((r) => r.id === stationId) ?? null;
      // A resolved fetch with no matching row means the station is gone —
      // a dead deep link must say so instead of rendering a broken shell.
      stationLoad = station ? "loaded" : "notFound";
    } catch (e) {
      stationLoad = "error";
      stationLoadError = e instanceof Error ? e.message : "Couldn't load this agent.";
    }
  }

  onMount(() => {
    void loadStation();
  });

  const tabs = $derived.by(() => [
    ...(hasAcp ? [{ id: "chat", label: "Chat", icon: MessageSquareIcon }] : []),
    { id: "health", label: "Health", icon: HeartPulseIcon },
    { id: "logs", label: "Logs", icon: ScrollTextIcon },
    { id: "files", label: "Files", icon: FolderIcon },
    ...(hasTerminal ? [{ id: "terminal", label: "Terminal", icon: TerminalIcon }] : []),
    ...(hasCleanup ? [{ id: "cleanup", label: "Cleanup", icon: Trash2Icon }] : []),
    { id: "activity", label: "Activity", icon: ActivityIcon },
  ]);

  function handleTabChange(tabId: string) {
    const url = new URL($page.url);
    if (tabId === defaultTab) {
      url.searchParams.delete("tab");
    } else {
      url.searchParams.set("tab", tabId);
    }
    void goto(url, { noScroll: true, keepFocus: true });
  }
</script>

{#snippet keepAlivePanel(id: Tab, content: Snippet)}
  {#if visitedHeavyTabs.has(id)}
    <div
      role="tabpanel"
      id="{tabsId}-panel-{id}"
      aria-labelledby="{tabsId}-tab-{id}"
      class={activeTab === id ? "contents" : "hidden"}
    >
      {@render content()}
    </div>
  {/if}
{/snippet}

{#snippet mountedPanel(id: Tab, content: Snippet)}
  {#if activeTab === id}
    <div role="tabpanel" id="{tabsId}-panel-{id}" aria-labelledby="{tabsId}-tab-{id}">
      {@render content()}
    </div>
  {/if}
{/snippet}

<svelte:head>
  <title>{station?.displayName ?? "Agent"} · AgentPod</title>
</svelte:head>

<!-- Themed header: station name, harness badge, back link, and tab bar -->
<PageHeader
  title={station?.displayName ?? (stationLoad === "loaded" || stationLoad === "loading" ? stationId : "Agent")}
  subtitle={station?.workspacePath ?? undefined}
  tabs={stationLoad === "notFound" || stationLoad === "error" ? [] : tabs}
  activeTab={activeTab}
  onTabChange={handleTabChange}
  sticky={true}
  {tabsId}
>
  {#snippet leading()}
    <Button
      variant="ghost"
      size="icon"
      href="/nodes/{nodeId}"
      class="h-8 w-8 border border-border/30 hover:border-primary hover:text-primary"
      aria-label="Back to node"
    >
      <ArrowLeftIcon class="h-4 w-4" />
    </Button>
    {#if station?.harness}
      <HarnessBadge harness={station.harness} class="shrink-0" />
    {/if}
  {/snippet}
</PageHeader>

<!-- Panel content -->
<div class="container mx-auto flex max-w-7xl flex-1 flex-col px-4 py-4 sm:px-6 md:py-6 min-h-0">
  {#if stationLoad === "notFound"}
    <div
      class="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center"
      data-testid="station-not-found"
    >
      <p class="text-sm font-medium">Agent not found</p>
      <p class="max-w-sm text-sm text-muted-foreground">
        This agent is no longer on the node — it may have been removed or renamed.
      </p>
      <Button href="/nodes/{nodeId}" variant="outline" size="sm">Back to node</Button>
    </div>
  {:else if stationLoad === "error"}
    <div
      class="flex items-start justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
      role="alert"
    >
      <p class="text-sm text-destructive">{stationLoadError}</p>
      <Button variant="outline" size="sm" onclick={() => loadStation()}>Retry</Button>
    </div>
  {:else if stationLoad === "loaded"}
    {@render stationPanels()}
  {/if}
  <!-- Panels wait for the capability list: which tab is the default depends on
       it (chat for acp stations, health otherwise), so rendering earlier would
       mount — and fetch for — a panel the user never asked for. -->
</div>

{#snippet stationPanels()}
  {#if hasAcp}
    {@render keepAlivePanel("chat", chatContent)}
    {#snippet chatContent()}
      <!-- Keyed on the station: the panel's controller binds its session (and
           socket) at construction, so a different station gets a fresh panel
           rather than a live socket pointed at the wrong agent. -->
      {#key stationId}
        <div class="flex-1 min-h-[320px]">
          <ChatPanel {stationId} />
        </div>
      {/key}
    {/snippet}
  {/if}

  {@render mountedPanel("health", healthContent)}
  {#snippet healthContent()}
    <HealthPanel {stationId} {canLifecycle} matrixId={station?.matrixId ?? null} />
  {/snippet}

  {@render keepAlivePanel("logs", logsContent)}
  {#snippet logsContent()}
    <div class="flex-1 min-h-[320px]">
      <LogTail {stationId} />
    </div>
  {/snippet}

  {@render keepAlivePanel("files", filesContent)}
  {#snippet filesContent()}
    <div class="flex-1 min-h-[320px]">
      <FileBrowser
        bind:this={fileBrowser}
        {stationId}
        {canWrite}
        onOpenConfigEditor={canWrite ? (p) => (configEditorPath = p) : undefined}
      />
    </div>
  {/snippet}

  {#if hasTerminal}
    {@render keepAlivePanel("terminal", terminalContent)}
    {#snippet terminalContent()}
      <div class="flex-1 min-h-[320px]">
        <Terminal {stationId} />
      </div>
    {/snippet}
  {/if}

  {#if hasCleanup}
    {@render mountedPanel("cleanup", cleanupContent)}
    {#snippet cleanupContent()}
      <div class="min-h-[200px]">
        <CleanupPanel {stationId} />
      </div>
    {/snippet}
  {/if}

  {@render mountedPanel("activity", activityContent)}
  {#snippet activityContent()}
    <div class="min-h-[200px]">
      <ActivityPanel {stationId} />
    </div>
  {/snippet}
{/snippet}

<!-- ── ConfigEditor dialog (opened via "Edit (diff)" in the FileBrowser) ── -->
<Dialog.Root
  open={configEditorPath !== null && canWrite}
  onOpenChange={(open) => {
    // Escape/overlay-close must go through the editor's unsaved-changes guard;
    // the editor calls onClose (below) once closing is actually safe.
    if (!open) {
      if (configEditor) {
        configEditor.requestClose();
      } else {
        configEditorPath = null;
      }
    }
  }}
>
  <Dialog.Content
    class="flex h-[80vh] max-w-4xl sm:max-w-4xl flex-col overflow-hidden p-0"
    showCloseButton={false}
  >
    {#if configEditorPath !== null && canWrite}
      <ConfigEditor
        bind:this={configEditor}
        {stationId}
        path={configEditorPath}
        onClose={() => (configEditorPath = null)}
        onSaved={(p) => fileBrowser?.invalidate(p)}
      />
    {/if}
  </Dialog.Content>
</Dialog.Root>
