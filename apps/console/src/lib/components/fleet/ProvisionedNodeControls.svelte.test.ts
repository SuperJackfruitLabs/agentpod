/**
 * ProvisionedNodeControls.svelte.test.ts
 *
 * TDD tests for the provisioned-node badge + destroy/stop/start controls.
 * RED → implement ProvisionedNodeControls.svelte → GREEN.
 *
 * Mocks $lib/api/client and $app/navigation; asserts:
 *  - docker node: shows "provisioned · docker" badge + Destroy + Stop + Start
 *  - cloudflare node: shows "provisioned · cloudflare" badge + Destroy only (no Stop/Start)
 *  - null provisioned: no badge, no controls rendered
 *  - Destroy: type hostname → enables button → click → destroyRuntime(runtimeId) called → goto("/")
 *  - Destroy failure: shows inline error, does not navigate
 *  - Stop/Start: call stopRuntime/startRuntime and emit onRefresh
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup, within } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import * as nav from "$app/navigation";
import ProvisionedNodeControls from "./ProvisionedNodeControls.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const dockerNode = {
  id: "node_1",
  name: "box1",
  hostname: "box1.local",
  os: "linux",
  arch: "amd64",
  cpuCount: 2,
  status: "online" as const,
  lastSeenAt: null,
  createdAt: "2026-06-29T00:00:00Z",
  agentVersion: null,
  latestVersion: null,
  updateAvailable: false,
  provisioned: { runtimeId: "rt_docker_1", provider: "docker" },
};

const cloudflareNode = {
  ...dockerNode,
  id: "node_2",
  hostname: "cf-box.local",
  provisioned: { runtimeId: "rt_cf_1", provider: "cloudflare" },
};

const unprovisionedNode = {
  ...dockerNode,
  id: "node_3",
  hostname: "manual.local",
  provisioned: null,
};

// ─── Badge visibility ─────────────────────────────────────────────────────────

test("docker node: shows provisioned badge with provider", async () => {
  const { getByText } = render(ProvisionedNodeControls, {
    props: { node: dockerNode, onRefresh: vi.fn() },
  });

  expect(getByText(/provisioned/i)).toBeTruthy();
  expect(getByText(/docker/i)).toBeTruthy();
});

test("cloudflare node: shows provisioned badge with provider", async () => {
  const { getByText } = render(ProvisionedNodeControls, {
    props: { node: cloudflareNode, onRefresh: vi.fn() },
  });

  expect(getByText(/provisioned/i)).toBeTruthy();
  expect(getByText(/cloudflare/i)).toBeTruthy();
});

test("unprovisioned node: no badge, no controls", async () => {
  const { queryByText, queryByRole } = render(ProvisionedNodeControls, {
    props: { node: unprovisionedNode, onRefresh: vi.fn() },
  });

  expect(queryByText(/provisioned/i)).toBeNull();
  expect(queryByRole("button", { name: /destroy/i })).toBeNull();
});

// ─── Controls presence ────────────────────────────────────────────────────────

test("docker node: shows Destroy + Stop + Start buttons", async () => {
  const { getByRole } = render(ProvisionedNodeControls, {
    props: { node: dockerNode, onRefresh: vi.fn() },
  });

  expect(getByRole("button", { name: /destroy/i })).toBeTruthy();
  expect(getByRole("button", { name: /stop/i })).toBeTruthy();
  expect(getByRole("button", { name: /start/i })).toBeTruthy();
});

test("cloudflare node: shows Destroy only, no Stop/Start", async () => {
  const { getByRole, queryByRole } = render(ProvisionedNodeControls, {
    props: { node: cloudflareNode, onRefresh: vi.fn() },
  });

  expect(getByRole("button", { name: /destroy/i })).toBeTruthy();
  expect(queryByRole("button", { name: /stop/i })).toBeNull();
  expect(queryByRole("button", { name: /start/i })).toBeNull();
});

// ─── Destroy flow ─────────────────────────────────────────────────────────────

test("Destroy: type hostname enables confirm button → calls destroyRuntime(runtimeId) → goto('/')", async () => {
  vi.spyOn(api, "destroyRuntime").mockResolvedValue(undefined as unknown as void);
  const gotoSpy = vi.spyOn(nav, "goto").mockResolvedValue(undefined);

  const { getAllByRole, getByRole } = render(ProvisionedNodeControls, {
    props: { node: dockerNode, onRefresh: vi.fn() },
  });

  // Open the destroy dialog (first "Destroy" button is the trigger)
  const [triggerBtn] = getAllByRole("button", { name: /destroy/i });
  fireEvent.click(triggerBtn);

  // Wait for dialog to open and find the confirm input
  await waitFor(() => {
    expect(getByRole("dialog")).toBeTruthy();
  });

  const input = within(getByRole("dialog")).getByRole("textbox");

  // Wrong input: dialog confirm button still disabled (last "Destroy" button = dialog's)
  fireEvent.input(input, { target: { value: "wrong" } });
  await waitFor(() => {
    const btns = getAllByRole("button", { name: /destroy/i }) as HTMLButtonElement[];
    const dialogBtn = btns[btns.length - 1];
    expect(dialogBtn.disabled).toBe(true);
  });

  // Correct input: confirm enabled
  fireEvent.input(input, { target: { value: "box1.local" } });
  await waitFor(() => {
    const btns = getAllByRole("button", { name: /destroy/i }) as HTMLButtonElement[];
    const dialogBtn = btns[btns.length - 1];
    expect(dialogBtn.disabled).toBe(false);
  });

  // Click confirm (last Destroy button = dialog's confirm)
  const btns = getAllByRole("button", { name: /destroy/i }) as HTMLButtonElement[];
  fireEvent.click(btns[btns.length - 1]);

  await waitFor(() => {
    expect(api.destroyRuntime).toHaveBeenCalledWith("rt_docker_1");
    expect(gotoSpy).toHaveBeenCalledWith("/");
  });
});

test("Destroy failure: shows inline error, dialog closes, does NOT navigate", async () => {
  vi.spyOn(api, "destroyRuntime").mockRejectedValue(new Error("destroy failed: quota"));
  const gotoSpy = vi.spyOn(nav, "goto").mockResolvedValue(undefined);

  const { getAllByRole, getByRole, queryByRole, getByText } = render(ProvisionedNodeControls, {
    props: { node: dockerNode, onRefresh: vi.fn() },
  });

  const [triggerBtn] = getAllByRole("button", { name: /destroy/i });
  fireEvent.click(triggerBtn);

  await waitFor(() => expect(getByRole("dialog")).toBeTruthy());

  fireEvent.input(within(getByRole("dialog")).getByRole("textbox"), {
    target: { value: "box1.local" },
  });
  await waitFor(() => {
    const btns = getAllByRole("button", { name: /destroy/i }) as HTMLButtonElement[];
    expect(btns[btns.length - 1].disabled).toBe(false);
  });

  const btns = getAllByRole("button", { name: /destroy/i }) as HTMLButtonElement[];
  fireEvent.click(btns[btns.length - 1]);

  await waitFor(() => {
    // (a) error text is visible on the page
    expect(getByText(/destroy failed/i)).toBeTruthy();
    // (b) dialog is closed — confirm input no longer in the DOM
    expect(queryByRole("dialog")).toBeNull();
    // (c) navigation did NOT happen
    expect(gotoSpy).not.toHaveBeenCalled();
  });
});

// ─── Stop / Start flows ───────────────────────────────────────────────────────

test("Stop: calls stopRuntime(runtimeId) and onRefresh", async () => {
  vi.spyOn(api, "stopRuntime").mockResolvedValue(undefined as unknown as void);
  const onRefresh = vi.fn();

  const { getByRole } = render(ProvisionedNodeControls, {
    props: { node: dockerNode, onRefresh },
  });

  fireEvent.click(getByRole("button", { name: /stop/i }));

  await waitFor(() => {
    expect(api.stopRuntime).toHaveBeenCalledWith("rt_docker_1");
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

test("Start: calls startRuntime(runtimeId) and onRefresh", async () => {
  vi.spyOn(api, "startRuntime").mockResolvedValue(undefined as unknown as void);
  const onRefresh = vi.fn();

  const { getByRole } = render(ProvisionedNodeControls, {
    props: { node: dockerNode, onRefresh },
  });

  fireEvent.click(getByRole("button", { name: /start/i }));

  await waitFor(() => {
    expect(api.startRuntime).toHaveBeenCalledWith("rt_docker_1");
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
