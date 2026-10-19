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

export function navItems(isAdmin: boolean): NavItem[] {
  return ALL.filter((i) => i.id !== "admin" || isAdmin);
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
export function moreItems(isAdmin: boolean): NavItem[] {
  return navItems(isAdmin).filter((i) => !PHONE_SECTIONS.includes(i.id));
}

export function phoneItems(): NavItem[] {
  return ALL.filter((i) => PHONE_SECTIONS.includes(i.id));
}
