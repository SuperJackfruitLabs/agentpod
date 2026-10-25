import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import * as api from "$lib/api/approval-rules";
import ApprovalRulesPanel from "./ApprovalRulesPanel.svelte";

const rule = { id: "r1", scope: "workspace-write" as const, setBy: "prn_owner", setAt: "2026-10-26T00:00:00.000Z" };
beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

test("an admin turns on Always allow for workspace writes", async () => {
  vi.spyOn(api, "listApprovalRules").mockResolvedValue([]);
  const set = vi.spyOn(api, "setApprovalRule").mockResolvedValue(rule);
  const view = render(ApprovalRulesPanel, { props: { stationId: "station_1", canChange: true } });
  const toggle = await waitFor(() => view.getByRole("switch"));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await fireEvent.click(toggle);
  await waitFor(() => expect(set).toHaveBeenCalledWith("station_1", "workspace-write"));
  await waitFor(() => expect(view.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
  expect(view.getByText(/Set by prn_owner/)).toBeTruthy();
});

test("an admin turns it off, which revokes the rule", async () => {
  vi.spyOn(api, "listApprovalRules").mockResolvedValue([rule]);
  const revoke = vi.spyOn(api, "revokeApprovalRule").mockResolvedValue({ revoked: true });
  const view = render(ApprovalRulesPanel, { props: { stationId: "station_1", canChange: true } });
  const toggle = await waitFor(() => view.getByRole("switch"));
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  await fireEvent.click(toggle);
  await waitFor(() => expect(revoke).toHaveBeenCalledWith("station_1", "r1"));
  await waitFor(() => expect(view.getByRole("switch").getAttribute("aria-checked")).toBe("false"));
});

test("a member sees the rule but cannot change it", async () => {
  vi.spyOn(api, "listApprovalRules").mockResolvedValue([rule]);
  const set = vi.spyOn(api, "setApprovalRule");
  const view = render(ApprovalRulesPanel, { props: { stationId: "station_1", canChange: false } });
  const toggle = await waitFor(() => view.getByRole("switch"));
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect((toggle as HTMLButtonElement).disabled).toBe(true);
  await fireEvent.click(toggle);
  expect(set).not.toHaveBeenCalled();
});
