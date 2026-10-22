/**
 * The console's one navigation: its sections, which one a path belongs to, and how the phone's
 * bottom bar folds the rest under More. Pure, so the three renderings (top row / Studio rail /
 * Quiet list, the phone bar, the More sheet) can never disagree about where you are.
 */
export type SectionId = "fleet" | "agents" | "nodes" | "runtimes" | "activity" | "settings" | "admin";

export interface NavItem {
  id: SectionId;
  label: string;
  href: string;
}

const ALL: NavItem[] = [
  { id: "fleet", label: "Fleet", href: "/" },
  { id: "agents", label: "Agents", href: "/agents" },
  { id: "nodes", label: "Nodes", href: "/nodes" },
  { id: "runtimes", label: "Runtimes", href: "/runtimes" },
  { id: "activity", label: "Activity", href: "/activity" },
  { id: "settings", label: "Settings", href: "/settings" },
  { id: "admin", label: "Admin", href: "/admin" },
];

/** What this session may change: the two flags from `/api/me`. */
export interface Access {
  /** Owner or admin of the workspace. */
  isWorkspaceAdmin: boolean;
  /** Holds the hub's operator seat. */
  isHubOperator: boolean;
}

export type AdminSectionId = "users" | "grants" | "bridge" | "transcription" | "speech";

export interface AdminSection {
  id: AdminSectionId;
  label: string;
  href: string;
  /** Who it is for: the workspace's admins, or the hub's operator (hub-wide settings). */
  audience: "workspace" | "hub";
}

const ADMIN_SECTIONS: AdminSection[] = [
  { id: "users", label: "Users", href: "/admin/users", audience: "workspace" },
  { id: "grants", label: "Grants", href: "/admin/grants", audience: "workspace" },
  { id: "bridge", label: "Bridge", href: "/admin/bridge", audience: "workspace" },
  { id: "transcription", label: "Transcription", href: "/admin/transcription", audience: "hub" },
  { id: "speech", label: "Speech", href: "/admin/speech", audience: "hub" },
];

/** The Admin pages this session may open: workspace pages for workspace admins, settings for hub operators. */
export function adminSections(access: Access): AdminSection[] {
  return ADMIN_SECTIONS.filter((s) => (s.audience === "hub" ? access.isHubOperator : access.isWorkspaceAdmin));
}

/** Who the admin page at `path` is for, or null outside the Admin area. */
export function adminAudience(path: string): "workspace" | "hub" | null {
  if (!under(path, "/admin")) return null;
  return ADMIN_SECTIONS.find((s) => under(path, s.href))?.audience ?? "workspace";
}

/** Admin appears when any of its pages may be opened, and leads to the first of them. */
export function navItems(access: Access): NavItem[] {
  const first = adminSections(access)[0];
  return ALL.flatMap((i) => (i.id !== "admin" ? [i] : first ? [{ ...i, href: first.href }] : []));
}

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/** The section a path belongs to. A station page is an agent's page, so it is Agents. */
export function currentSection(path: string): SectionId | null {
  if (path === "/") return "fleet";
  if (/^\/nodes\/[^/]+\/stations\//.test(path)) return "agents";
  for (const item of ALL) {
    if (item.id !== "fleet" && under(path, item.href)) return item.id;
  }
  return null;
}

/** The phone bar's four places. */
export type PhoneId = "fleet" | "agents" | "activity" | "more";

export const PHONE_SECTIONS: SectionId[] = ["fleet", "agents", "activity"];

export function phoneCurrent(path: string): PhoneId | null {
  const s = currentSection(path);
  if (s === null) return null;
  return (PHONE_SECTIONS as string[]).includes(s) ? (s as PhoneId) : "more";
}

/** What the More sheet lists: every section the bar does not. */
export function moreItems(access: Access): NavItem[] {
  return navItems(access).filter((i) => !PHONE_SECTIONS.includes(i.id));
}

export function phoneItems(): NavItem[] {
  return ALL.filter((i) => PHONE_SECTIONS.includes(i.id));
}
