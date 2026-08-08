/**
 * BanUserDialog.svelte.test.ts
 *
 * TDD tests for the shared ban-user confirmation dialog (extracted from the
 * duplicated ban dialogs on the admin users list and user-detail pages).
 * RED → implement BanUserDialog.svelte → GREEN.
 *
 * HARD CONSTRAINT: this component must import ONLY `banUser` from
 * $lib/api/admin — the user-detail page's test mock covers exactly
 * getUser/banUser/unbanUser/updateUserRole, so the mock below intentionally
 * exports only banUser to prove the component doesn't reach for anything else.
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";

vi.mock("svelte-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("$lib/api/admin", () => ({
  banUser: vi.fn(),
}));

import * as adminApi from "$lib/api/admin";
import BanUserDialog from "./BanUserDialog.svelte";

const user = { id: "u1", email: "u@x", name: "U" };

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

test("open renders the target user's email and a required-reason field", () => {
  const { getByText, getByLabelText } = render(BanUserDialog, {
    props: { open: true, user, onBanned: vi.fn() },
  });
  expect(getByText(/u@x/)).toBeTruthy();
  expect(getByLabelText(/reason/i)).toBeTruthy();
});

test("confirm is disabled until a reason is entered (validation blocks)", async () => {
  const { getByRole, getByLabelText } = render(BanUserDialog, {
    props: { open: true, user, onBanned: vi.fn() },
  });
  const confirmBtn = getByRole("button", { name: /ban user/i }) as HTMLButtonElement;
  expect(confirmBtn.disabled).toBe(true);

  // Whitespace-only reason still blocks the confirm
  const textarea = getByLabelText(/reason/i);
  await fireEvent.input(textarea, { target: { value: "   " } });
  expect(confirmBtn.disabled).toBe(true);
});

test("confirming calls banUser with the trimmed reason and fires onBanned on success", async () => {
  vi.mocked(adminApi.banUser).mockResolvedValue({} as never);
  const onBanned = vi.fn();

  const { getByRole, getByLabelText } = render(BanUserDialog, {
    props: { open: true, user, onBanned },
  });

  const textarea = getByLabelText(/reason/i);
  await fireEvent.input(textarea, { target: { value: "  spamming  " } });

  const confirmBtn = getByRole("button", { name: /ban user/i }) as HTMLButtonElement;
  await waitFor(() => expect(confirmBtn.disabled).toBe(false));
  await fireEvent.click(confirmBtn);

  await waitFor(() => {
    expect(adminApi.banUser).toHaveBeenCalledWith("u1", "spamming");
    expect(onBanned).toHaveBeenCalledOnce();
  });
});

test("failed banUser does not call onBanned", async () => {
  vi.mocked(adminApi.banUser).mockRejectedValue(new Error("boom"));
  const onBanned = vi.fn();

  const { getByRole, getByLabelText } = render(BanUserDialog, {
    props: { open: true, user, onBanned },
  });

  const textarea = getByLabelText(/reason/i);
  await fireEvent.input(textarea, { target: { value: "spam" } });

  const confirmBtn = getByRole("button", { name: /ban user/i }) as HTMLButtonElement;
  await waitFor(() => expect(confirmBtn.disabled).toBe(false));
  await fireEvent.click(confirmBtn);

  await waitFor(() => {
    expect(adminApi.banUser).toHaveBeenCalled();
    expect(onBanned).not.toHaveBeenCalled();
  });
});
