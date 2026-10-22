/**
 * The shell's chrome around the stage: the navigation, the account chip and its menu, the
 * Appearance control, and the phone's bottom bar with its More sheet.
 */
import { test, expect, vi, beforeEach, describe } from "vitest";
import { render, fireEvent, within } from "@testing-library/svelte";

const { mockPage, mockAuth, mockLogout, mockGoto } = vi.hoisted(() => ({
  mockPage: { url: new URL("https://console.test/") },
  mockAuth: {
    initials: "RG",
    email: "rakesh@example.com" as string | null,
    user: { role: "admin" as string | null },
    isWorkspaceAdmin: true,
    isHubOperator: false,
  },
  mockLogout: vi.fn(async () => {}),
  mockGoto: vi.fn(async () => {}),
}));

vi.mock("$app/state", () => ({ page: mockPage }));
vi.mock("$app/navigation", () => ({ goto: mockGoto }));
vi.mock("$lib/stores/auth.svelte", () => ({ auth: mockAuth, logout: mockLogout }));

import Navigation from "./Navigation.svelte";
import AccountMenu from "./AccountMenu.svelte";
import AppearanceControl from "./AppearanceControl.svelte";
import PhoneBar from "./PhoneBar.svelte";
import MoreSheet from "./MoreSheet.svelte";
import { appearance } from "$lib/appearance.svelte";

beforeEach(() => {
  mockPage.url = new URL("https://console.test/");
  mockAuth.user = { role: "admin" };
  mockAuth.isWorkspaceAdmin = true;
  mockAuth.isHubOperator = false;
  mockAuth.email = "rakesh@example.com";
  mockLogout.mockClear();
  mockGoto.mockClear();
  document.cookie = "vk_appearance=; Max-Age=0; path=/";
  appearance.set({ vibe: "daylight", theme: "sun", accents: {} });
});

const labels = (root: HTMLElement) =>
  [...root.querySelectorAll("a")].map((a) => a.textContent?.trim());

describe("Navigation", () => {
  test("lists the seven sections for an admin, in order", () => {
    const { getByRole } = render(Navigation);
    const nav = getByRole("navigation", { name: "Console" });
    expect(labels(nav)).toEqual(["Fleet", "Agents", "Nodes", "Runtimes", "Activity", "Settings", "Admin"]);
  });

  test("hides Admin from someone who is not an admin", () => {
    mockAuth.user = { role: null };
    mockAuth.isWorkspaceAdmin = false;
    const { getByRole } = render(Navigation);
    expect(labels(getByRole("navigation", { name: "Console" }))).not.toContain("Admin");
  });

  test("a hub operator who is a workspace member gets Admin, leading to the hub settings", () => {
    mockAuth.isWorkspaceAdmin = false;
    mockAuth.isHubOperator = true;
    const { getByRole } = render(Navigation);
    const nav = getByRole("navigation", { name: "Console" });
    expect(within(nav).getByRole("link", { name: "Admin" }).getAttribute("href")).toBe("/admin/transcription");
  });

  test("marks the current section with aria-current, from the route", () => {
    mockPage.url = new URL("https://console.test/nodes/n1");
    const { getByRole } = render(Navigation);
    const nav = getByRole("navigation", { name: "Console" });
    const current = nav.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent?.trim()).toBe("Nodes");
    expect(current[0].getAttribute("href")).toBe("/nodes");
  });

  test("a station page is under Agents", () => {
    mockPage.url = new URL("https://console.test/nodes/n1/stations/s1");
    const { getByRole } = render(Navigation);
    expect(getByRole("link", { name: "Agents" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("AppearanceControl", () => {
  test("vibe, Light / Dark / Follow the sun, and accent, each pressed for the current choice", () => {
    const { getByRole } = render(AppearanceControl);
    expect(getByRole("button", { name: "Daylight" }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", { name: "Follow the sun" }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", { name: "Cobalt, product default" }).getAttribute("aria-pressed")).toBe("true");
    for (const name of ["Paper", "Studio", "Quiet", "Light", "Dark"]) {
      expect(getByRole("button", { name }).getAttribute("aria-pressed")).toBe("false");
    }
  });

  test("choosing writes the appearance", async () => {
    const { getByRole } = render(AppearanceControl);
    await fireEvent.click(getByRole("button", { name: "Studio" }));
    await fireEvent.click(getByRole("button", { name: "Dark" }));
    await fireEvent.click(getByRole("button", { name: "Superwitness colour" }));
    expect(appearance.value.vibe).toBe("studio");
    expect(appearance.value.theme).toBe("dark");
    expect(appearance.accent).toBe("jade");
    expect(document.documentElement.dataset.vibe).toBe("studio");
    expect(getByRole("button", { name: "Studio" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("has no time-of-day control", () => {
    const { queryByText } = render(AppearanceControl);
    expect(queryByText(/time of day/i)).toBeNull();
  });
});

describe("AccountMenu", () => {
  test("the chip shows the initials and the email", () => {
    const { getByTestId } = render(AccountMenu);
    const chip = getByTestId("account-chip");
    expect(getByTestId("user-avatar").textContent?.trim()).toBe("RG");
    expect(chip.textContent).toContain("rakesh@example.com");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    // It opens a non-modal dialog, not a menu.
    expect(chip.getAttribute("aria-haspopup")).toBe("dialog");
  });

  test("the menu holds Appearance and Sign out; Appearance expands the control", async () => {
    const { getByTestId, getByRole, queryByRole } = render(AccountMenu);
    await fireEvent.click(getByTestId("account-chip"));
    expect(getByTestId("account-chip").getAttribute("aria-expanded")).toBe("true");
    const menu = getByTestId("account-menu");
    const appearanceBtn = within(menu).getByRole("button", { name: "Appearance" });
    expect(within(menu).getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(queryByRole("button", { name: "Daylight" })).toBeNull();
    await fireEvent.click(appearanceBtn);
    expect(appearanceBtn.getAttribute("aria-expanded")).toBe("true");
    expect(getByRole("button", { name: "Daylight" })).toBeTruthy();
  });

  test("Sign out signs out, then goes to /login", async () => {
    const { getByTestId } = render(AccountMenu);
    await fireEvent.click(getByTestId("account-chip"));
    await fireEvent.click(within(getByTestId("account-menu")).getByRole("button", { name: "Sign out" }));
    await vi.waitFor(() => expect(mockGoto).toHaveBeenCalledWith("/login"));
    expect(mockLogout).toHaveBeenCalledOnce();
  });

  test("Escape closes the menu and gives focus back to the chip", async () => {
    const { getByTestId, queryByTestId } = render(AccountMenu);
    await fireEvent.click(getByTestId("account-chip"));
    await fireEvent.keyDown(getByTestId("account-menu"), { key: "Escape" });
    expect(queryByTestId("account-menu")).toBeNull();
    expect(document.activeElement).toBe(getByTestId("account-chip"));
  });
});

describe("PhoneBar", () => {
  test("Fleet, Agents, Activity and More", () => {
    const { getByRole } = render(PhoneBar);
    const bar = getByRole("navigation", { name: "Console, phone" });
    expect(bar.textContent).toMatch(/Fleet.*Agents.*Activity.*More/s);
    expect(within(bar).getByRole("link", { name: "Fleet" }).getAttribute("aria-current")).toBe("page");
  });

  test.each(["/nodes", "/runtimes", "/settings", "/admin/users"])("More is current on %s", (path) => {
    mockPage.url = new URL(`https://console.test${path}`);
    const { getByRole } = render(PhoneBar);
    const bar = getByRole("navigation", { name: "Console, phone" });
    expect(within(bar).getByRole("button", { name: "More" }).getAttribute("aria-current")).toBe("page");
    expect(bar.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  test("More opens the sheet", async () => {
    const { getByRole } = render(PhoneBar);
    const more = getByRole("button", { name: "More" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-testid="more-sheet"]')).not.toBeNull();
  });
});

describe("MoreSheet", () => {
  test("holds Nodes, Runtimes, Settings, Admin, Appearance, the email and Sign out", async () => {
    render(MoreSheet, { props: { open: true } });
    const sheet = document.querySelector<HTMLElement>('[data-testid="more-sheet"]')!;
    const pages = within(sheet).getByRole("navigation", { name: "More pages" });
    expect(labels(pages)).toEqual(["Nodes", "Runtimes", "Settings", "Admin"]);
    expect(within(sheet).getByRole("button", { name: "Appearance" })).toBeTruthy();
    expect(sheet.textContent).toContain("rakesh@example.com");
    await fireEvent.click(within(sheet).getByRole("button", { name: "Sign out" }));
    await vi.waitFor(() => expect(mockGoto).toHaveBeenCalledWith("/login"));
  });

  test("no Admin for someone who is not an admin", () => {
    mockAuth.user = { role: null };
    mockAuth.isWorkspaceAdmin = false;
    render(MoreSheet, { props: { open: true } });
    const sheet = document.querySelector<HTMLElement>('[data-testid="more-sheet"]')!;
    expect(labels(within(sheet).getByRole("navigation", { name: "More pages" }))).toEqual([
      "Nodes",
      "Runtimes",
      "Settings",
    ]);
  });
});
