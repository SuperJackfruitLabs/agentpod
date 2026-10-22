import { describe, expect, test } from "vitest";
import { navItems, currentSection, phoneCurrent, moreItems, adminSections, adminAudience } from "./nav";

const MEMBER = { isWorkspaceAdmin: false, isHubOperator: false };
const WS_ADMIN = { isWorkspaceAdmin: true, isHubOperator: false };
const OPERATOR = { isWorkspaceAdmin: false, isHubOperator: true };
const BOTH = { isWorkspaceAdmin: true, isHubOperator: true };

describe("workspace authority in the navigation", () => {
  test("a member has no Admin section", () => {
    expect(navItems(MEMBER).some((i) => i.id === "admin")).toBe(false);
    expect(moreItems(MEMBER).some((i) => i.id === "admin")).toBe(false);
    expect(adminSections(MEMBER)).toEqual([]);
  });

  test("a workspace admin's Admin holds the workspace pages, not the hub settings", () => {
    expect(adminSections(WS_ADMIN).map((s) => s.label)).toEqual(["Users", "Grants", "Bridge"]);
    expect(navItems(WS_ADMIN).find((i) => i.id === "admin")?.href).toBe("/admin/users");
  });

  test("a hub operator who is not a workspace admin sees only the hub settings, and Admin leads there", () => {
    expect(adminSections(OPERATOR).map((s) => s.label)).toEqual(["Transcription", "Speech"]);
    expect(navItems(OPERATOR).find((i) => i.id === "admin")?.href).toBe("/admin/transcription");
    expect(moreItems(OPERATOR).map((i) => i.label)).toContain("Admin");
  });

  test("holding both shows every Admin page", () => {
    expect(adminSections(BOTH).map((s) => s.id)).toEqual(["users", "grants", "bridge", "transcription", "speech"]);
  });

  test.each([
    ["/admin", "workspace"],
    ["/admin/users/u1", "workspace"],
    ["/admin/bridge", "workspace"],
    ["/admin/transcription", "hub"],
    ["/admin/speech", "hub"],
    ["/settings", null],
  ])("%s is for the %s", (path, audience) => {
    expect(adminAudience(path)).toBe(audience);
  });
});

describe("navigation", () => {
  test("lists Fleet, Agents, Nodes, Runtimes, Activity, Settings; Admin only for admins", () => {
    expect(navItems(MEMBER).map((i) => i.label)).toEqual([
      "Fleet",
      "Agents",
      "Nodes",
      "Runtimes",
      "Activity",
      "Settings",
    ]);
    expect(navItems(WS_ADMIN).map((i) => i.label)).toEqual([
      "Fleet",
      "Agents",
      "Nodes",
      "Runtimes",
      "Activity",
      "Settings",
      "Admin",
    ]);
  });

  test.each([
    ["/", "fleet"],
    ["/agents", "agents"],
    ["/nodes", "nodes"],
    ["/nodes/n1", "nodes"],
    ["/nodes/n1/stations/s1", "agents"],
    ["/runtimes", "runtimes"],
    ["/activity", "activity"],
    ["/settings", "settings"],
    ["/admin/users", "admin"],
    ["/elsewhere", null],
  ])("%s is the %s section", (path, id) => {
    expect(currentSection(path)).toBe(id);
  });

  test.each([
    ["/", "fleet"],
    ["/agents", "agents"],
    ["/activity", "activity"],
    ["/nodes", "more"],
    ["/runtimes", "more"],
    ["/settings", "more"],
    ["/admin", "more"],
  ])("on a phone %s marks %s current", (path, id) => {
    expect(phoneCurrent(path)).toBe(id);
  });

  test("the More sheet holds Nodes, Runtimes, Settings, and Admin for admins", () => {
    expect(moreItems(MEMBER).map((i) => i.label)).toEqual(["Nodes", "Runtimes", "Settings"]);
    expect(moreItems(WS_ADMIN).map((i) => i.label)).toEqual(["Nodes", "Runtimes", "Settings", "Admin"]);
  });
});
