<script lang="ts">
  /**
   * One tab for how this agent is configured.
   *
   * Declared configuration, plugin enablement and skill registration are not
   * three unrelated things: on a Hermes station they all write the SAME
   * configuration document, and declared configuration reaches the other two
   * by calling the very writers their own verbs call. Splitting them across a
   * "Skills" tab and the "Files" tab told the operator a story the node does
   * not tell. Order is how often a setting is touched, not alphabetical.
   *
   * The page keeps this tab alive once visited (keepAlivePanel, not mountedPanel): the
   * declared-configuration panel captures a plan and its digest once and never re-fetches them,
   * so remounting it would throw away a review in progress.
   */
  import type { StationRow } from "$lib/api/client";
  import SkillsPanel from "$lib/components/stations/SkillsPanel.svelte";
  import SkillManagementPanel from "$lib/components/stations/SkillManagementPanel.svelte";
  import PluginManagementPanel from "$lib/components/stations/PluginManagementPanel.svelte";
  import HarnessConfigPanel from "$lib/components/stations/HarnessConfigPanel.svelte";
  import McpProxyStatus from "$lib/components/stations/McpProxyStatus.svelte";
  import ApprovalRulesPanel from "$lib/components/stations/ApprovalRulesPanel.svelte";
  import { workspaceAdminsCan } from "$lib/workspace-authority";
  import type { ConfigSection } from "./tabs";

  interface Props {
    stationId: string;
    nodeId: string;
    station: StationRow | null;
    wsAdmin: boolean;
    mayChange: boolean;
    hasConfigManagement: boolean;
    hasPluginManagement: boolean;
    hasSkillInventory: boolean;
    hasSkillManagement: boolean;
    hasNativeSkillManagement: boolean;
    sections: { id: ConfigSection; label: string }[];
    section: ConfigSection;
    /** Whether the Configuration tab is the one on screen. */
    active: boolean;
    onSection: (id: ConfigSection) => void;
    /** Ask (through the page's confirm) to restart the agent; absent without lifecycle. */
    onRestart?: () => void;
  }

  let {
    stationId,
    nodeId,
    station,
    wsAdmin,
    mayChange,
    hasConfigManagement,
    hasPluginManagement,
    hasSkillInventory,
    hasSkillManagement,
    hasNativeSkillManagement,
    sections,
    section,
    active,
    onSection,
    onRestart,
  }: Props = $props();
</script>

<div class="ap-cfg flex flex-col">
  {#if sections.length > 1}
    <nav aria-label="Configuration sections" class="ap-cfg-nav flex gap-1 border-b px-4 pt-4">
      {#each sections as s (s.id)}
        <button
          type="button"
          aria-current={section === s.id ? "page" : undefined}
          class="min-h-11 rounded-t-md border-b-2 px-3 py-1.5 text-sm {section === s.id
            ? 'border-foreground font-medium text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground'}"
          onclick={() => onSection(s.id)}
        >
          {s.label}
        </button>
      {/each}
    </nav>
  {/if}

  <!-- Hidden, never unmounted. The declared-configuration panel captures
       a plan and its digest once and never re-fetches them, so a section
       switch must not be able to tear it down mid-review. -->
  <div data-config-section="settings" class={section === "settings" ? "contents" : "hidden"}>
    <McpProxyStatus {stationId} />
    {#if station?.harness === "salaam"}
      <ApprovalRulesPanel {stationId} canChange={wsAdmin} />
    {/if}
    {#if hasConfigManagement && !wsAdmin}
      <div class="ap-cfg-placeholder space-y-2 p-4" data-testid="config-member">
        <h2 class="font-semibold">Declared configuration</h2>
        <p class="text-sm text-muted-foreground">{workspaceAdminsCan("change this agent's configuration")}</p>
      </div>
    {:else if hasConfigManagement}
      <HarnessConfigPanel
        {stationId}
        {nodeId}
        stationKey={station?.stationKey}
        active={active && section === "settings"}
        {onRestart}
      />
    {:else}
      <div class="ap-cfg-placeholder space-y-2 p-4">
        <h2 class="font-semibold">Declared configuration</h2>
        <!-- Indented as it was on the page, so the text node is byte-for-byte what it was. -->
        <p class="text-sm text-muted-foreground">
                This station's node has not enabled configuration management, so nothing can be declared for
                it here. A node advertises <code>config.manage</code> once its agent's configuration sets
                <code>configManagement</code>; until then the harness's own settings are reachable only on the
                host.
              </p>
      </div>
    {/if}
  </div>

  {#if hasPluginManagement}
    <div data-config-section="plugins" class={section === "plugins" ? "contents" : "hidden"}>
      <PluginManagementPanel {stationId} canManage={mayChange} {onRestart} />
    </div>
  {/if}

  {#if hasSkillInventory || hasSkillManagement || hasNativeSkillManagement}
    <div data-config-section="skills" class={section === "skills" ? "contents" : "hidden"}>
      {#if hasSkillInventory}<SkillsPanel {stationId} />{/if}
      {#if hasSkillManagement || hasNativeSkillManagement}
        <SkillManagementPanel
          {stationId}
          harness={station?.harness ?? ""}
          canManage={hasSkillManagement && mayChange}
          canNative={hasNativeSkillManagement && mayChange}
        />
      {/if}
    </div>
  {/if}
</div>
