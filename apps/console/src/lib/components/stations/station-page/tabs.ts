/**
 * The station page's tabs and the Configuration tab's sections: which exist for a station, in
 * what order, and which one a URL selects. Pure, so the route page only composes.
 */
import type { Component } from "svelte";
import HeartPulseIcon from "@lucide/svelte/icons/heart-pulse";
import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
import SlidersHorizontalIcon from "@lucide/svelte/icons/sliders-horizontal";
import FolderIcon from "@lucide/svelte/icons/folder";
import TerminalIcon from "@lucide/svelte/icons/terminal";
import GitCompareIcon from "@lucide/svelte/icons/git-compare";
import HistoryIcon from "@lucide/svelte/icons/history";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import ActivityIcon from "@lucide/svelte/icons/activity";
import MessageSquareIcon from "@lucide/svelte/icons/message-square";
import IdCardIcon from "@lucide/svelte/icons/id-card";
import { workspaceAdminsCan } from "$lib/workspace-authority";

export type Tab =
  | "chat"
  | "health"
  | "logs"
  | "files"
  | "terminal"
  | "config"
  | "changes"
  | "timeline"
  | "cleanup"
  | "activity"
  | "identity";

export const VALID_TABS: readonly Tab[] = [
  "chat",
  "health",
  "logs",
  "files",
  "terminal",
  "config",
  "changes",
  "timeline",
  "cleanup",
  "activity",
  "identity",
];

/**
 * Retired tab ids, mapped to what replaced them.
 *
 * Tab ids live in the URL, so links to them sit in bookmarks, in chat history
 * and in docs. An unknown ?tab= value falls back to the default tab SILENTLY
 * (below), which would land a two-week-old link on Health with no
 * explanation — so a retired id is aliased, never dropped. `skills` became
 * `config` when plugins, skills and declared configuration were gathered into
 * one tab, because on a Hermes station all three write the same file.
 */
export const TAB_ALIASES: Readonly<Record<string, Tab>> = { skills: "config" };

export interface TabDef {
  id: Tab;
  label: string;
  icon: Component;
  disabled?: boolean;
  disabledReason?: string;
}

function isTab(t: string | null | undefined): t is Tab {
  return VALID_TABS.some((tab) => tab === t);
}

/**
 * The tab a `?tab=` value selects. An absent or unknown param falls back to the station's
 * default tab: talking to the agent is the point of an ACP-capable station, so chat leads there
 * and health leads everywhere else.
 */
export function resolveTab(raw: string | null | undefined, tabs: readonly TabDef[], defaultTab: Tab): Tab {
  const t = raw === null || raw === undefined ? raw : (TAB_ALIASES[raw] ?? raw);
  const wanted = isTab(t) ? t : defaultTab;
  // The active tab must be one the tab bar actually renders. The tablist has
  // a roving tabindex keyed on it, so a tab that isn't there (a ?tab=chat
  // deep link while capabilities load, ?tab=identity after a resize past
  // 1240px) would leave the WHOLE tablist untabbable.
  return tabs.some((tab) => tab.id === wanted) ? wanted : defaultTab;
}

/** Heavy tabs (SSE stream / file tree / terminal session) stay mounted once visited, so a tab
 *  switch does not drop the log stream, the tree state or the terminal scrollback. Health,
 *  cleanup and activity stay plain if-mounted: they fetch fresh data on every mount (e.g.
 *  Activity's onMount fetch), and keeping them alive would make that data go stale while the
 *  tab is hidden. */
export function isHeavyTab(tab: Tab): boolean {
  return (
    tab === "chat" ||
    tab === "logs" ||
    tab === "files" ||
    tab === "terminal" ||
    // Declared configuration captures a plan and its digest once and never
    // re-fetches them: remounting would destroy a review in progress, so
    // this tab is kept alive and refreshes its rows on re-entry.
    tab === "config"
  );
}

export interface TabFlags {
  hasAcp: boolean;
  /** Between the phone layout and the width where the shell has a context column. */
  identityTab: boolean;
  hasTerminal: boolean;
  mayChange: boolean;
  wsAdmin: boolean;
  hasConfiguration: boolean;
  hasChangeset: boolean;
  harness: string | undefined;
  hasCleanup: boolean;
}

/** The tabs a station gets, in the console's order. */
export function stationTabs(f: TabFlags): TabDef[] {
  return [
    ...(f.hasAcp ? [{ id: "chat" as const, label: "Chat", icon: MessageSquareIcon }] : []),
    // Second, not last.
    //
    // On a wide screen this is not a tab at all — it is the context rail, on
    // screen permanently beside whatever else you are doing. Its importance
    // does not change when the viewport narrows; only the room does. Appending
    // it after Activity put "which agent is this, and who may dispatch it"
    // behind a horizontal scroll past seven other tabs, which is the opposite
    // of what the rail does for free. It is the frame for the rest, so it sits
    // where you reach it without hunting: immediately after the conversation.
    ...(f.identityTab ? [{ id: "identity" as const, label: "Identity", icon: IdCardIcon }] : []),
    { id: "health" as const, label: "Health", icon: HeartPulseIcon },
    { id: "logs" as const, label: "Logs", icon: ScrollTextIcon },
    { id: "files" as const, label: "Files", icon: FolderIcon },
    ...(f.hasTerminal
      ? [
          {
            id: "terminal" as const,
            label: "Terminal",
            icon: TerminalIcon,
            // A shell changes what an agent is, so it sits behind mayGrantReach.
            // Shown-and-locked rather than hidden: a missing tab reads as "this
            // agent has no terminal", which is a different and wrong answer.
            disabled: !f.mayChange,
            disabledReason: f.wsAdmin ? "You may dispatch this agent but not change it" : workspaceAdminsCan("open a terminal"),
          },
        ]
      : []),
    ...(f.hasConfiguration
      ? [{ id: "config" as const, label: "Configuration", icon: SlidersHorizontalIcon }]
      : []),
    ...(f.hasChangeset ? [{ id: "changes" as const, label: "Changes", icon: GitCompareIcon }] : []),
    ...(f.harness === "salaam" ? [{ id: "timeline" as const, label: "Timeline", icon: HistoryIcon }] : []),
    ...(f.hasCleanup ? [{ id: "cleanup" as const, label: "Cleanup", icon: Trash2Icon }] : []),
    { id: "activity" as const, label: "Activity", icon: ActivityIcon },
  ];
}

/**
 * The Configuration tab shows ONE section at a time.
 *
 * Measured on a live station before this existed: the tab was 6174px of
 * content in a 753px pane — 8.2 screens — of which the skill inventory was
 * 4960px and the declared-configuration panel, the thing the tab is named
 * for, was 133px. Stacking everything made the rare thing bury the common
 * one.
 *
 * Settings is always offered, even where the node has not enabled
 * configuration management: a tab called Configuration that contains no
 * configuration, and no word about why, is the worse answer.
 */
export type ConfigSection = "settings" | "plugins" | "skills";

export function configSectionsFor(hasPlugins: boolean, hasSkillsSection: boolean): { id: ConfigSection; label: string }[] {
  return [
    { id: "settings", label: "Settings" },
    ...(hasPlugins ? [{ id: "plugins" as const, label: "Plugins" }] : []),
    ...(hasSkillsSection ? [{ id: "skills" as const, label: "Skills" }] : []),
  ];
}

/** The section a `?section=` value selects; Settings when it names none of them. */
export function resolveConfigSection(
  raw: string | null | undefined,
  sections: readonly { id: ConfigSection }[],
): ConfigSection {
  return sections.find((s) => s.id === raw)?.id ?? "settings";
}
