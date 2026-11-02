<script lang="ts">
  import { upTo } from "$lib/breakpoints";
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
  import type { Snippet } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import HealthPanel from "$lib/components/stations/HealthPanel.svelte";
  import LogTail from "$lib/components/stations/LogTail.svelte";
  import FileBrowser from "$lib/components/stations/FileBrowser.svelte";
  import Terminal from "$lib/components/stations/Terminal.svelte";
  import ChatPanel from "$lib/components/stations/chat/ChatPanel.svelte";
  import CleanupPanel from "$lib/components/stations/CleanupPanel.svelte";
  import ChangesetPanel from "$lib/components/stations/ChangesetPanel.svelte";
  import TimelinePanel from "$lib/components/stations/TimelinePanel.svelte";
  import PostureBanner from "$lib/components/stations/PostureBanner.svelte";
  import ActivityPanel from "$lib/components/stations/ActivityPanel.svelte";
  import { lifecycle, listStations, setStationPurpose } from "$lib/api/client";
  import { myReach } from "$lib/api/my-grant";
  import { auth } from "$lib/stores/auth.svelte";
  import type { StationRow } from "$lib/api/client";
  import ContextRail from "$lib/components/shell/ContextRail.svelte";
  import { stationState } from "$lib/fleet/state";
  import { fleet, refreshFleet } from "$lib/stores/fleet.svelte";
  import { setContextRail } from "$lib/stores/context-rail.svelte";
  import { relativeTime } from "$lib/utils/relative-time";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import StationHeader from "$lib/components/stations/station-page/StationHeader.svelte";
  import StationTabBar from "$lib/components/stations/station-page/StationTabBar.svelte";
  import StationConfigTab from "$lib/components/stations/station-page/StationConfigTab.svelte";
  import StationAboutSheet from "$lib/components/stations/station-page/StationAboutSheet.svelte";
  import StationConfigEditorDialog from "$lib/components/stations/station-page/StationConfigEditorDialog.svelte";
  import {
    configSectionsFor,
    isHeavyTab,
    resolveConfigSection,
    resolveTab,
    stationTabs,
    type ConfigSection,
    type Tab,
  } from "$lib/components/stations/station-page/tabs";

  const nodeId = $derived($page.params.id as string);
  const stationId = $derived($page.params.stationId as string);

  // The active tab lives in the URL (?tab=logs) so station views are
  // deep-linkable, survive refresh, and participate in back/forward.
  const activeTab = $derived.by<Tab>(() => resolveTab($page.url.searchParams?.get("tab"), tabs, defaultTab));

  /** Base id the tab buttons and the tabpanels build their ids from — kept in
   *  one place so aria-controls and aria-labelledby can't drift apart. */
  const tabsId = "page-tabs";

  /** Heavy tabs (isHeavyTab) the user has switched to at least once — kept
   *  mounted after that. */
  let visitedHeavyTabs = $state(new Set<Tab>());
  $effect(() => {
    if (isHeavyTab(activeTab) && !visitedHeavyTabs.has(activeTab)) {
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

  /**
   * A workspace member uses an agent (chat, logs, files to read) but does not change it: the
   * hub refuses a member's lifecycle, terminal, file writes, configuration, skills, cleanup,
   * avatar and purpose, so none of those is offered.
   */
  const wsAdmin = $derived(auth.isWorkspaceAdmin);
  const mayChange = $derived(mayGrantReach && wsAdmin);

  const canWrite = $derived(
    Array.isArray(station?.capabilities) &&
      station!.capabilities.includes("fs.write") &&
      mayChange
  );

  const canLifecycle = $derived(
    wsAdmin && Array.isArray(station?.capabilities) && station!.capabilities.includes("lifecycle")
  );

  // Logs and Files are always tabs, but only a station that advertises the capability gets the
  // panel. Without it the node has nothing to send: the log tail sat on "Reconnecting…" forever
  // and the file tree failed (spec 2026-10-23, C5/C6). Say so plainly instead.
  const hasLogs = $derived(station?.capabilities?.includes("logs") ?? false);
  const hasFsRead = $derived(station?.capabilities?.includes("fs.read") ?? false);
  const hasSkillInventory = $derived(station?.capabilities?.includes("skills.inventory") ?? false);
  const hasSkillManagement = $derived(station?.capabilities?.includes("skills.manage") ?? false);
  const hasNativeSkillManagement = $derived(station?.capabilities?.includes("skills.native") ?? false);
  const hasPluginManagement = $derived(station?.capabilities?.includes("plugins.manage") ?? false);
  // Declared harness configuration (read-only panel, spec D13) — gated the
  // same way `hasPluginManagement` gates its panel: a station that does not
  // advertise the capability renders nothing, not an empty panel.
  const hasConfigManagement = $derived(station?.capabilities?.includes("config.manage") ?? false);
  // A Matrix identity the hub can put a face on: the appservice's own user for
  // a bridge-mode agent, or a harness login the node can use (`matrix.avatar`).
  const canSetAvatar = $derived(
    wsAdmin &&
      (station?.matrixIdentityMode === "bridge" ||
        (station?.capabilities?.includes("matrix.avatar") ?? false))
  );
  const hasSkills = $derived(hasSkillInventory || hasSkillManagement || hasNativeSkillManagement || hasPluginManagement);
  /** The Configuration tab shows ONE section at a time (configSectionsFor says why). */
  const configSections = $derived(
    configSectionsFor(hasPluginManagement, hasSkillInventory || hasSkillManagement || hasNativeSkillManagement),
  );
  const configSection = $derived<ConfigSection>(
    resolveConfigSection($page.url.searchParams?.get("section"), configSections),
  );
  function setConfigSection(id: ConfigSection) {
    const url = new URL($page.url);
    if (id === "settings") url.searchParams.delete("section");
    else url.searchParams.set("section", id);
    void goto(url, { noScroll: true, keepFocus: true });
  }

  /** The Configuration tab's gate. Declared configuration is reason enough for
   *  the tab on its own: a station can advertise `config.manage` with no skills
   *  capability at all, and before this it had no home but the Files tab. */
  const hasConfiguration = $derived(hasSkills || hasConfigManagement);

  const hasChangeset = $derived(
    Array.isArray(station?.capabilities) && station!.capabilities.includes("changeset")
  );

  // Cleanup only deletes, and deleting is a workspace admin's: a member has no use for the tab.
  const hasCleanup = $derived(
    wsAdmin && Array.isArray(station?.capabilities) && station!.capabilities.includes("cleanup")
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
   * A JS media query, not a Tailwind max-[N] variant: Tailwind
   * compiles those to an exclusive `not all and (min-width: N)`, which is exclusive and
   * leaves 1240px itself in neither branch — the boundary bug this redesign
   * already hit once at 900px.
   */
  let narrow = $state(false);
  /** At 900px and below (the phone layout) the rail is the About sheet, not a tab. */
  let phone = $state(false);
  let aboutOpen = $state(false);

  onMount(() => {
    void myReach().then((r) => (mayGrantReach = r.mayGrantReach));

    const mq = window.matchMedia(upTo("rail"));
    narrow = mq.matches;
    const onChange = (e: MediaQueryListEvent) => (narrow = e.matches);
    mq.addEventListener("change", onChange);
    const pq = window.matchMedia(upTo("phone"));
    phone = pq.matches;
    const onPhone = (e: MediaQueryListEvent) => {
      phone = e.matches;
      if (!e.matches) aboutOpen = false;
    };
    pq.addEventListener("change", onPhone);
    return () => {
      mq.removeEventListener("change", onChange);
      pq.removeEventListener("change", onPhone);
    };
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
    aboutOpen = false;
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

  const tabs = $derived(
    stationTabs({
      hasAcp,
      identityTab: narrow && !phone,
      hasTerminal,
      mayChange,
      wsAdmin,
      hasConfiguration,
      hasChangeset,
      harness: station?.harness,
      hasCleanup,
    }),
  );

  function handleTabChange(tabId: string) {
    const url = new URL($page.url);
    // ?section= belongs to the Configuration tab; carrying it onto Logs would
    // leave a parameter that means nothing where it lands.
    if (tabId !== "config") url.searchParams.delete("section");
    if (tabId === defaultTab) {
      url.searchParams.delete("tab");
    } else {
      url.searchParams.set("tab", tabId);
    }
    void goto(url, { noScroll: true, keepFocus: true });
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
    onSavePurpose={wsAdmin ? savePurpose : undefined}
    onSetupComplete={() => { void loadStation(); void refreshFleet(); }}
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
<div class="ap-station flex min-h-0 flex-1 flex-col" data-testid="station-page">
  <StationHeader
    {station}
    {stationId}
    {nodeId}
    {stationLoad}
    {liveState}
    {nodeName}
    {lastSpoke}
    {canLifecycle}
    {actionInFlight}
    {actionError}
    {phone}
    onAsk={askFor}
    onAbout={() => (aboutOpen = true)}
  >
    {#if stationLoad !== "notFound" && stationLoad !== "error"}
      <StationTabBar {tabs} {activeTab} {tabsId} onSelect={handleTabChange} />
    {/if}
  </StationHeader>

  <!-- The panel region is the page's one scroller: panels with a scroller of
       their own (chat, logs, files, terminal) fill it exactly and never
       overflow; the shorter ones (health, activity, changes, cleanup) scroll
       here, under a header that stays put. -->
  <div class="ap-st-panes flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 sm:px-6" data-testid="station-panes">
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
    {#if hasLogs}
      <div class="min-h-0 flex-1">
        <LogTail {stationId} />
      </div>
    {:else if station}
      <p class="p-6 text-sm text-muted-foreground" data-testid="logs-unavailable">This agent doesn't share its logs with AgentPod.</p>
    {/if}
  {/snippet}

  {@render keepAlivePanel("files", filesContent)}
  {#snippet filesContent()}
    {#if hasFsRead}
      <div class="flex min-h-0 flex-1 flex-col">
        <div class="min-h-0 flex-1">
          <FileBrowser
            bind:this={fileBrowser}
            {stationId}
            {canWrite}
            {canSetAvatar}
            onOpenConfigEditor={canWrite ? (p) => (configEditorPath = p) : undefined}
          />
        </div>
      </div>
    {:else if station}
      <p class="p-6 text-sm text-muted-foreground" data-testid="files-unavailable">This agent doesn't share its files with AgentPod.</p>
    {/if}
  {/snippet}

  {#if hasTerminal}
    {@render keepAlivePanel("terminal", terminalContent)}
    {#snippet terminalContent()}
      <div class="min-h-0 flex-1">
        <Terminal {stationId} />
      </div>
    {/snippet}
  {/if}

  {#if hasConfiguration}
    <!-- keepAlivePanel, not mountedPanel: StationConfigTab says why. -->
    {@render keepAlivePanel("config", configContent)}
    {#snippet configContent()}
      <StationConfigTab
        {stationId}
        {nodeId}
        {station}
        {wsAdmin}
        {mayChange}
        {hasConfigManagement}
        {hasPluginManagement}
        {hasSkillInventory}
        {hasSkillManagement}
        {hasNativeSkillManagement}
        sections={configSections}
        section={configSection}
        active={activeTab === "config"}
        onSection={setConfigSection}
        onRestart={canLifecycle ? () => askFor("restart") : undefined}
      />
    {/snippet}
  {/if}

  {#if station?.harness === "salaam"}
    {@render mountedPanel("timeline", timelineContent)}
    {#snippet timelineContent()}
      <div class="min-h-[200px]">
        <TimelinePanel {stationId} canRestore={wsAdmin} />
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

  {#if narrow && !phone}
    <!-- The rail's content, for the widths where the shell has no room for a
         third column. Same component, so the two can never say different
         things about the same agent. -->
    {@render mountedPanel("identity", identityContent)}
    {#snippet identityContent()}
      {@render stationRail()}
    {/snippet}
  {/if}
{/snippet}

{#if phone && station}
  <StationAboutSheet bind:open={aboutOpen} {station} {canLifecycle} {actionInFlight} onAsk={askFor} rail={stationRail} />
{/if}

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

<StationConfigEditorDialog
  {stationId}
  bind:path={configEditorPath}
  {canWrite}
  onSaved={(p) => fileBrowser?.invalidate(p)}
/>
