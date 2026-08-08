import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import TypeToConfirmDialog from "./TypeToConfirmDialog.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const baseProps = {
  open: true,
  title: "Delete station",
  message: "This cannot be undone.",
  confirmPhrase: "my-station",
  confirmLabel: "Delete station",
};

test("TypeToConfirmDialog: confirm button is disabled initially", () => {
  const { getByRole } = render(TypeToConfirmDialog, {
    props: { ...baseProps, onConfirm: vi.fn(), onCancel: vi.fn() },
  });

  const confirmBtn = getByRole("button", { name: "Delete station" }) as HTMLButtonElement;
  expect(confirmBtn.disabled).toBe(true);
});

test("TypeToConfirmDialog: input never reveals the confirm phrase as a placeholder", () => {
  // Regression: the placeholder used to echo confirmPhrase, letting users copy
  // the answer out of the very field meant to prove deliberate intent.
  const { getByRole } = render(TypeToConfirmDialog, {
    props: { ...baseProps, onConfirm: vi.fn(), onCancel: vi.fn() },
  });

  const input = getByRole("textbox") as HTMLInputElement;
  expect(input.placeholder).toBe("");
});

test("TypeToConfirmDialog: wrong input keeps confirm button disabled", () => {
  const { getByRole } = render(TypeToConfirmDialog, {
    props: { ...baseProps, onConfirm: vi.fn(), onCancel: vi.fn() },
  });

  const input = getByRole("textbox");
  fireEvent.input(input, { target: { value: "wrong-value" } });

  const confirmBtn = getByRole("button", { name: "Delete station" }) as HTMLButtonElement;
  expect(confirmBtn.disabled).toBe(true);
});

test("TypeToConfirmDialog: matching input enables button and fires onConfirm on click", async () => {
  const onConfirm = vi.fn();

  const { getByRole } = render(TypeToConfirmDialog, {
    props: { ...baseProps, onConfirm, onCancel: vi.fn() },
  });

  const input = getByRole("textbox");
  fireEvent.input(input, { target: { value: "my-station" } });

  await waitFor(() => {
    const btn = getByRole("button", { name: "Delete station" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  fireEvent.click(getByRole("button", { name: "Delete station" }));
  expect(onConfirm).toHaveBeenCalledOnce();
});

test("TypeToConfirmDialog: Cancel button fires onCancel", () => {
  const onCancel = vi.fn();

  const { getByRole } = render(TypeToConfirmDialog, {
    props: { ...baseProps, onConfirm: vi.fn(), onCancel },
  });

  fireEvent.click(getByRole("button", { name: /cancel/i }));
  expect(onCancel).toHaveBeenCalledOnce();
});

test("TypeToConfirmDialog: not rendered when open=false", () => {
  const { queryByRole } = render(TypeToConfirmDialog, {
    props: { ...baseProps, open: false, onConfirm: vi.fn(), onCancel: vi.fn() },
  });

  expect(queryByRole("dialog")).toBeNull();
});
