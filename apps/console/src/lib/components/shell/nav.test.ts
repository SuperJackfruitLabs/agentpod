import { describe, expect, test } from "vitest";
import { navItems, currentSection, phoneCurrent, moreItems } from "./nav";

describe("navigation", () => {
  test("lists Fleet, Agents, Nodes, Runtimes, Activity, Settings; Admin only for admins", () => {
    expect(navItems(false).map((i) => i.label)).toEqual([
      "Fleet",
      "Agents",
      "Nodes",
      "Runtimes",
      "Activity",
      "Settings",
    ]);
    expect(navItems(true).map((i) => i.label)).toEqual([
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
    expect(moreItems(false).map((i) => i.label)).toEqual(["Nodes", "Runtimes", "Settings"]);
    expect(moreItems(true).map((i) => i.label)).toEqual(["Nodes", "Runtimes", "Settings", "Admin"]);
  });
});
