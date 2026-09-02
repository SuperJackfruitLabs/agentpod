<script lang="ts">
  /**
   * The station page — where you talk to an agent.
   *
   * It used to open on two settings cards (the purpose editor and the Matrix
   * identity panel) stacked above whichever tab was selected, so the Chat tab
   * — the whole point of an ACP-capable station — began below the fold. Both
   * cards moved to the shell's context rail, which is where facts ABOUT an
   * agent belong; the stage is now the conversation and nothing else.
   *
   * The panels themselves are re-hosted, not rewritten: the transcript, the
   * file tree, the terminal, the log tail, the diff viewer, the config editor,
   * the cleanup panel and the identity panel are the same components with the
   * same props they always had.
   */
  import { onMount } from "svelte";
  import type { Component, Snippet } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import HealthPanel from "$lib/components/stations/HealthPanel.svelte";
  import LogTail from "$lib/components/stations/LogTail.svelte";
  import FileBrowser from "$lib/components/stations/FileBrowser.svelte";
  import ConfigEditor from "$lib/components/stations/ConfigEditor.svelte";
  import Terminal from "$lib/components/stations/Terminal.svelte";
  import ChatPanel from "$lib/components/stations/chat/ChatPanel.svelte";
  import CleanupPanel from "$lib/components/stations/CleanupPanel.svelte";
  import ChangesetPanel from "$lib/components/stations/ChangesetPanel.svelte";
  import PostureBanner from "$lib/components/stations/PostureBanner.svelte";
  import ActivityPanel from "$lib/components/stations/ActivityPanel.svelte";
  import { lifecycle, listStations, setStationPurpose } from "$lib/api/client";
  import { myReach } from "$lib/api/my-grant";
  import type { StationRow } from "$lib/api/client";
  import ContextRail from "$lib/components/shell/ContextRail.svelte";
  import StateDot from "$lib/components/shell/StateDot.svelte";
  import { stationState } from "$lib/fleet/state";
  import { fleet, refreshFleet } from "$lib/stores/fleet.svelte";
  import { setContextRail } from "$lib/stores/context-rail.svelte";
  import { relativeTime } from "$lib/utils/relative-time";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import { cn } from "$lib/utils";
  import HeartPulseIcon from "@lucide/svelte/icons/heart-pulse";
  import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
  import FolderIcon from "@lucide/svelte/icons/folder";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import GitCompareIcon from "@lucide/svelte/icons/git-compare";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import MessageSquareIcon from "@lucide/svelte/icons/message-square";
  import IdCardIcon from "@lucide/svelte/icons/id-card";
  import LockIcon from "@lucide/svelte/icons/lock";

  const nodeId = $derived($page.params.id as string);
  const stationId = $derived($page.params.stationId as string);

  type Tab =
    | "chat"
    | "health"
    | "logs"
    | "files"
    | "terminal"
    | "changes"
    | "cleanup"
    | "activity"
    | "identity";
  const VALID_TABS: readonly Tab[] = [
    "chat",
    "health",
    "logs",
    "files",
    "terminal",
    "changes",
    "cleanup",
    "activity",
    "identity",
  ];

  // The active tab lives in the URL (?tab=logs) so station views are
  // deep-linkable, survive refresh, and participate in back/forward.
  // An absent or unknown param falls back to the station's default tab: talking
  // to the agent is the point of an ACP-capable station, so chat leads there and
  // health leads everywhere else.
  const activeTab = $derived.by<Tab>(() => {
    const t = $page.url.searchParams?.get("tab");
    const wanted = VALID_TABS.includes(t as Tab) ? (t as Tab) : defaultTab;
    // The active tab must be one the tab bar actually renders. The tablist has
    // a roving tabindex keyed on it, so a tab that isn't there (a ?tab=chat
    // deep link while capabilities load, ?tab=identity after a resize past
    // 1240px) would leave the WHOLE tablist untabbable.
    return tabs.some((tab) => tab.id === wanted) ? wanted : defaultTab;
  });

  /** Base id the tab buttons and the tabpanels build their ids from — kept in
   *  one place so aria-controls and aria-labelledby can't drift apart. */
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

  /**
   * Whether this principal may change what this agent *is* — the reach half of
   * the control pair (#345).
   *
   * Advisory: the hub refuses regardless. It is read so a control that would be
   * refused can say so rather than 403 on click, and it defaults to true so a
   * hub that cannot be asked never hides a control the operator holds.
   */
  let mayGrantReach = $state(true);

  const canWrite = $derived(
    Array.isArray(station?.capabilities) &&
      station!.capabilities.includes("fs.write") &&
      mayGrantReach
  );

  const canLifecycle = $derived(
    Array.isArray(station?.capabilities) && station!.capabilities.includes("lifecycle")
  );

  const hasChangeset = $derived(
    Array.isArray(station?.capabilities) && station!.capabilities.includes("changeset")
  );

  const hasCleanup = $derived(
    Array.isArray(station?.capabilities) && station!.capabilities.includes("cleanup")
  );

  /** Which station the loaded row describes, so a reload of the SAME agent
   *  (after saving its purpose) can be told from a move to a different one. */
  let loadedFor: string | null = null;

  async function loadStation() {
    const id = stationId;
    stationLoad = "loading";
    stationLoadError = null;
    if (loadedFor !== id) {
      // A different agent. Its facts must not be shown under the previous
      // one's name for the length of a fetch — and a heavy tab remembered for
      // the agent we just left is not a tab this one has visited.
      station = null;
      visitedHeavyTabs = new Set();
      actionError = null;
    }
    try {
      const rows = await listStations(nodeId);
      // A reply about a station we have since navigated away from. Without
      // this a slow first fetch overwrites a fast second one.
      if (stationId !== id) return;
      station = rows.find((r) => r.id === id) ?? null;
      loadedFor = id;
      // A resolved fetch with no matching row means the station is gone —
      // a dead deep link must say so instead of rendering a broken shell.
      stationLoad = station ? "loaded" : "notFound";
    } catch (e) {
      if (stationId !== id) return;
      stationLoad = "error";
      stationLoadError = e instanceof Error ? e.message : "Couldn't load this agent.";
    }
  }

  /**
   * Load whichever agent the URL names — on arrival AND on every move between
   * agents.
   *
   * `[stationId]/+page.svelte` is ONE page reused across every station, so a
   * change of station id does not remount it and an `onMount` fetch would only
   * ever run for the first agent visited. That was survivable while the only
   * way in was the node page (a different route, so a real remount); with the
   * roster rail as the console's navigation, agent-to-agent is the ordinary
   * move, and without this the URL changed while the previous agent's header,
   * tabs, panels and rail stayed on screen.
   */
  $effect(() => {
    void nodeId;
    void stationId;
    void loadStation();
  });

  /**
   * Below 1240px the shell renders no context column, so the rail's content
   * becomes a tab instead of disappearing.
   *
   * A JS media query, not a Tailwind `max-[1240px]:` variant: Tailwind
   * compiles those to `not all and (min-width:1240px)`, which is exclusive and
   * leaves 1240px itself in neither branch — the boundary bug this redesign
   * already hit once at 900px.
   */
  let narrow = $state(false);

  onMount(() => {
    void myReach().then((r) => (mayGrantReach = r.mayGrantReach));

    const mq = window.matchMedia("(max-width: 1240px)");
    narrow = mq.matches;
    const onChange = (e: MediaQueryListEvent) => (narrow = e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  });

  // ─── The header's facts ───────────────────────────────────────────────────

  /**
   * This station in the shared fleet snapshot.
   *
   * The shell already polls it for the roster and the attention lane, so the
   * header's live state costs no request of its own — and reading the same
   * snapshot the rail on the left is drawn from is what stops the two from
   * disagreeing about whether this agent is running.
   */
  const fleetAgent = $derived(fleet.agents.find((a) => a.stationId === stationId) ?? null);
  const node = $derived(fleet.nodes.find((n) => n.id === nodeId) ?? null);
  const liveState = $derived(stationState(fleetAgent?.status ?? "unknown"));
  const nodeName = $derived(fleetAgent?.nodeName ?? node?.name ?? nodeId);

  /**
   * How long since anything was heard about this agent.
   *
   * The node's `lastSeenAt`, because a station has no timestamp of its own on
   * the fleet endpoint — a station's health only reaches the hub on its node's
   * push, so the node's last-seen IS the age of what this header shows. It is
   * node-granular: two agents on one node always read the same age. Same
   * substitution the roster rail makes, and recorded as a gap in both reports.
   */
  const lastSpoke = $derived(relativeTime(node?.lastSeenAt ?? null));

  // ─── Lifecycle, from the header ───────────────────────────────────────────

  let pendingAction = $state<"stop" | "restart" | null>(null);
  let confirmOpen = $state(false);
  let actionInFlight = $state<"stop" | "restart" | null>(null);
  let actionError = $state<string | null>(null);

  function askFor(action: "stop" | "restart") {
    pendingAction = action;
    confirmOpen = true;
  }

  async function runLifecycle(action: "stop" | "restart") {
    actionInFlight = action;
    actionError = null;
    try {
      await lifecycle(stationId, action);
      // The header's dot comes from the shared snapshot, which is polled every
      // 30s — without this the state it shows would lag the button that just
      // changed it. `quiet` so the whole console doesn't flash a loading state.
      void refreshFleet(true);
    } catch (e) {
      actionError = e instanceof Error ? e.message : `Couldn't ${action} the agent.`;
    } finally {
      actionInFlight = null;
    }
  }

  // ─── Tabs ─────────────────────────────────────────────────────────────────

  interface TabDef {
    id: Tab;
    label: string;
    icon: Component;
    disabled?: boolean;
    disabledReason?: string;
  }

  const tabs = $derived.by<TabDef[]>(() => [
    ...(hasAcp ? [{ id: "chat" as const, label: "Chat", icon: MessageSquareIcon }] : []),
    // Second, not last.
    //
    // On a wide screen this is not a tab at all — it is the context rail, on
    // screen permanently beside whatever else you are doing. Its importance
    // does not change when the viewport narrows; only the room does. Appending
    // it after Activity put "which agent is this, and who may dispatch it"
    // behind a horizontal scroll past seven other tabs, which is the opposite
    // of what the rail does for free. It is the frame for the rest, so it sits
    // where you reach it without hunting: immediately after the conversation.
    ...(narrow ? [{ id: "identity" as const, label: "Identity", icon: IdCardIcon }] : []),
    { id: "health" as const, label: "Health", icon: HeartPulseIcon },
    { id: "logs" as const, label: "Logs", icon: ScrollTextIcon },
    { id: "files" as const, label: "Files", icon: FolderIcon },
    ...(hasTerminal
      ? [
          {
            id: "terminal" as const,
            label: "Terminal",
            icon: TerminalIcon,
            // A shell changes what an agent is, so it sits behind mayGrantReach.
            // Shown-and-locked rather than hidden: a missing tab reads as "this
            // agent has no terminal", which is a different and wrong answer.
            disabled: !mayGrantReach,
            disabledReason: "You may dispatch this agent but not change it",
          },
        ]
      : []),
    ...(hasChangeset ? [{ id: "changes" as const, label: "Changes", icon: GitCompareIcon }] : []),
    ...(hasCleanup ? [{ id: "cleanup" as const, label: "Cleanup", icon: Trash2Icon }] : []),
    { id: "activity" as const, label: "Activity", icon: ActivityIcon },
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

  /** Roving tabindex: only the selected tab is in the tab order, arrows move
   *  focus between them (WAI-ARIA tabs pattern). */
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
          handleTabChange(tabs[index].id);
        }
        break;
      }
    }
  }

  // ─── The context rail ─────────────────────────────────────────────────────

  async function savePurpose(purpose: string | null) {
    await setStationPurpose(stationId, purpose);
    await loadStation();
  }

  /**
   * Hand the rail to the shell for as long as this page is mounted.
   *
   * Not registered while `narrow`: below 1240px the shell renders no third
   * column, and the Identity tab already mounts the same component — two
   * copies would ask the hub for the grants twice.
   */
  $effect(() => {
    setContextRail(narrow ? null : stationRail);
    return () => setContextRail(null);
  });
</script>

{#snippet stationRail()}
  <ContextRail
    {station}
    {node}
    agentVersion={fleetAgent?.agentVersion ?? null}
    onSavePurpose={savePurpose}
  />
{/snippet}

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
    <div
      role="tabpanel"
      id="{tabsId}-panel-{id}"
      aria-labelledby="{tabsId}-tab-{id}"
    >
      {@render content()}
    </div>
  {/if}
{/snippet}

<svelte:head>
  <title>{station?.displayName ?? "Agent"} · AgentPod</title>
</svelte:head>

<!--
  h-full/min-h-0, never a growing column: the shell's stage is capped so this
  page's panes (the transcript, the file tree, the terminal, the log tail) own
  their own scrolling. A page that scrolled as a whole would take the header
  and the tab bar off screen with it and put the composer below the fold.
-->
<div class="flex min-h-0 flex-1 flex-col" data-testid="station-page">
  <!-- `relative`: StateDot's sr-only word is position:absolute, and with no
       positioned ancestor inside the stage's scroller it escapes every
       overflow-hidden between here and the document. -->
  <header class="relative shrink-0 border-b border-border bg-background">
    <div class="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-3 sm:px-6">
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <StateDot state={liveState} />
          <h1
            class="truncate font-mono text-[21px] leading-tight font-medium"
            data-testid="station-handle"
            title={station?.displayName ?? stationId}
          >
            {station?.displayName ??
              (stationLoad === "loaded" || stationLoad === "loading" ? stationId : "Agent")}
          </h1>
        </div>
        <p class="mt-1 truncate text-sm text-muted-foreground" data-testid="station-summary">
          {#if station}
            <!-- Mono for the machine-issued halves only; the joins are prose. -->
            <span class="font-mono" data-testid="station-key">{station.stationKey}</span>
            on <a class="font-mono underline-offset-2 hover:underline" href="/nodes/{nodeId}"
              >{nodeName}</a
            >
            · {liveState.label} · last spoke {lastSpoke === "—" ? "unknown" : lastSpoke}
          {:else if stationLoad === "loading"}
            Loading this agent…
          {/if}
        </p>
      </div>

      {#if canLifecycle}
        <div class="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={actionInFlight !== null}
            onclick={() => askFor("restart")}
          >
            {actionInFlight === "restart" ? "Restarting…" : "Restart"}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={actionInFlight !== null}
            onclick={() => askFor("stop")}
          >
            {actionInFlight === "stop" ? "Stopping…" : "Stop"}
          </Button>
        </div>
      {/if}
    </div>

    {#if actionError}
      <p class="px-4 pb-2 text-sm text-status-error sm:px-6" role="alert">{actionError}</p>
    {/if}

    {#if stationLoad !== "notFound" && stationLoad !== "error"}
      <!-- svelte-ignore a11y_interactive_supports_focus -- the roving tabindex lives on the tab buttons, not the tablist -->
      <div
        class="scrollbar-hide flex gap-1 overflow-x-auto px-4 sm:px-6"
        role="tablist"
        onkeydown={handleTablistKeydown}
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
              "flex items-center gap-2 border-b-2 px-2.5 py-2 text-sm whitespace-nowrap transition-colors",
              tab.disabled
                ? "cursor-not-allowed border-transparent text-muted-foreground/50"
                : activeTab === tab.id
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
            onclick={() => !tab.disabled && handleTabChange(tab.id)}
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
    {/if}
  </header>

  <!-- The panel region is the page's one scroller: panels with a scroller of
       their own (chat, logs, files, terminal) fill it exactly and never
       overflow; the shorter ones (health, activity, changes, cleanup) scroll
       here, under a header that stays put. -->
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 sm:px-6" data-testid="station-panes">
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
      {#if station}
        <!-- A posture failure naming THIS station is the one thing that outranks
             whatever tab you came for. The wrapper's margin applies only when
             the banner actually renders something. -->
        <div class="shrink-0 [&>*]:mb-3">
          <PostureBanner {nodeId} stationKey={station.stationKey} />
        </div>
      {/if}
      {@render stationPanels()}
    {:else}
      <!-- Panels wait for the capability list: which tab is the default depends on
           it (chat for acp stations, health otherwise), so rendering one earlier
           would mount — and fetch for — a panel the user never asked for. The
           shape of the wait is still shown, so the page isn't a bare header. -->
      <div class="flex flex-col gap-3" data-testid="station-panels-loading" aria-busy="true">
        <span class="sr-only">Loading this agent…</span>
        <Skeleton class="h-8 w-48 rounded-lg" />
        <Skeleton class="h-[320px] w-full rounded-lg" />
      </div>
    {/if}
  </div>
</div>

{#snippet stationPanels()}
  {#if hasAcp}
    {@render keepAlivePanel("chat", chatContent)}
    {#snippet chatContent()}
      <!-- Keyed on the station: the panel's controller binds its session (and
           socket) at construction, so a different station gets a fresh panel
           rather than a live socket pointed at the wrong agent. -->
      {#key stationId}
        <div class="min-h-0 flex-1">
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
    <div class="min-h-0 flex-1">
      <LogTail {stationId} />
    </div>
  {/snippet}

  {@render keepAlivePanel("files", filesContent)}
  {#snippet filesContent()}
    <div class="min-h-0 flex-1">
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
      <div class="min-h-0 flex-1">
        <Terminal {stationId} />
      </div>
    {/snippet}
  {/if}

  {#if hasChangeset}
    {@render mountedPanel("changes", changesContent)}
    {#snippet changesContent()}
      <div class="min-h-[200px]">
        <ChangesetPanel {stationId} />
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

  {#if narrow}
    <!-- The rail's content, for the widths where the shell has no room for a
         third column. Same component, so the two can never say different
         things about the same agent. -->
    {@render mountedPanel("identity", identityContent)}
    {#snippet identityContent()}
      {@render stationRail()}
    {/snippet}
  {/if}
{/snippet}

<ConfirmDialog
  open={confirmOpen}
  title="{pendingAction === 'stop' ? 'Stop' : 'Restart'} agent"
  message="This will {pendingAction ?? 'restart'} the agent process."
  confirmLabel={pendingAction === "stop" ? "Stop agent" : "Restart agent"}
  destructive={pendingAction === "stop"}
  onConfirm={() => {
    confirmOpen = false;
    const action = pendingAction;
    pendingAction = null;
    if (action) void runLifecycle(action);
  }}
  onCancel={() => {
    confirmOpen = false;
    pendingAction = null;
  }}
/>

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
