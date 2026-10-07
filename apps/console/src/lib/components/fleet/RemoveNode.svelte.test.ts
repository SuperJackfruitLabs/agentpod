/**
 * RemoveNode — the danger action on a node page.
 *
 * Type the node's name to confirm, then DELETE /api/nodes/:id and go back to
 * Nodes. A connected node says, before the click, that it will be disconnected
 * and has to be re-enrolled; the request carries force only for that node, so
 * the hub's online refusal stays the guard for every other caller.
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup, within } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import * as nav from "$app/navigation";
import RemoveNode from "./RemoveNode.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const offline = {
  id: "node_9",
  name: "build-01",
  hostname: "build-01.local",
  os: "linux",
  arch: "amd64",
  cpuCount: 2,
  status: "offline" as const,
  lastSeenAt: null,
  createdAt: "2026-06-29T00:00:00Z",
  agentVersion: null,
  latestVersion: null,
  updateAvailable: false,
  provisioned: null,
};
const online = { ...offline, status: "online" as const };

const removed = {
  ok: true as const,
  node: { id: "node_9", name: "build-01" },
  stationsRemoved: [],
  disconnected: false,
};

async function confirm(getByRole: (r: string, o?: object) => HTMLElement, getAllByRole: (r: string, o?: object) => HTMLElement[], phrase: string) {
  fireEvent.click(getByRole("button", { name: /remove node/i }));
  await waitFor(() => expect(getByRole("dialog")).toBeTruthy());
  fireEvent.input(within(getByRole("dialog")).getByRole("textbox"), { target: { value: phrase } });
  const buttons = () => getAllByRole("button", { name: /remove node/i }) as HTMLButtonElement[];
  await waitFor(() => expect(buttons()[buttons().length - 1].disabled).toBe(false));
  fireEvent.click(buttons()[buttons().length - 1]);
}

test("the confirm stays disabled until the node's name is typed", async () => {
  const { getByRole, getAllByRole } = render(RemoveNode, { props: { node: offline } });
  fireEvent.click(getByRole("button", { name: /remove node/i }));
  await waitFor(() => expect(getByRole("dialog")).toBeTruthy());
  fireEvent.input(within(getByRole("dialog")).getByRole("textbox"), { target: { value: "build-0" } });
  const btns = getAllByRole("button", { name: /remove node/i }) as HTMLButtonElement[];
  expect(btns[btns.length - 1].disabled).toBe(true);
});

test("an offline node is removed without force, then the page goes back to Nodes", async () => {
  const spy = vi.spyOn(api, "removeNode").mockResolvedValue(removed);
  const gotoSpy = vi.spyOn(nav, "goto").mockResolvedValue(undefined);
  const { getByRole, getAllByRole } = render(RemoveNode, { props: { node: offline } });

  await confirm(getByRole, getAllByRole, "build-01");

  await waitFor(() => {
    expect(spy).toHaveBeenCalledWith("node_9", { force: false });
    expect(gotoSpy).toHaveBeenCalledWith("/nodes");
  });
});

test("a connected node is warned about, and removed with force", async () => {
  const spy = vi.spyOn(api, "removeNode").mockResolvedValue({ ...removed, disconnected: true });
  vi.spyOn(nav, "goto").mockResolvedValue(undefined);
  const { getByRole, getAllByRole } = render(RemoveNode, { props: { node: online } });

  fireEvent.click(getByRole("button", { name: /remove node/i }));
  await waitFor(() => expect(getByRole("dialog")).toBeTruthy());
  expect(within(getByRole("dialog")).getByText(/disconnected.*re-enrol/i)).toBeTruthy();
  fireEvent.click(within(getByRole("dialog")).getByRole("button", { name: /cancel/i }));
  await waitFor(() => expect(getAllByRole("button", { name: /remove node/i })).toHaveLength(1));

  await confirm(getByRole, getAllByRole, "build-01");
  await waitFor(() => expect(spy).toHaveBeenCalledWith("node_9", { force: true }));
});

test("a refusal is shown on the page and nothing navigates", async () => {
  vi.spyOn(api, "removeNode").mockRejectedValue(new Error("Bridge agent ops still runs on a station here."));
  const gotoSpy = vi.spyOn(nav, "goto").mockResolvedValue(undefined);
  const { getByRole, getAllByRole, findByText } = render(RemoveNode, { props: { node: offline } });

  await confirm(getByRole, getAllByRole, "build-01");

  expect(await findByText(/bridge agent ops/i)).toBeTruthy();
  expect(gotoSpy).not.toHaveBeenCalled();
});
