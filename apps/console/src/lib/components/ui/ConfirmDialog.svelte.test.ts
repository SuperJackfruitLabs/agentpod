import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import ConfirmDialog from "./ConfirmDialog.svelte";

afterEach(() => cleanup());

const props = { open: true, title: "Delete file?", message: "This cannot be undone.", confirmLabel: "Delete file" };

test("an open dialog draws one overlay, not two (regression: doubled Portal and Overlay)", () => {
  render(ConfirmDialog, { props: { ...props, onConfirm: vi.fn(), onCancel: vi.fn() } });
  expect(document.querySelectorAll('[data-slot="dialog-overlay"]').length).toBe(1);
});

test("the confirm button is named for the action and confirms", async () => {
  const onConfirm = vi.fn();
  const { getByRole } = render(ConfirmDialog, { props: { ...props, onConfirm, onCancel: vi.fn() } });
  expect(getByRole("dialog")).toBeTruthy();
  await fireEvent.click(getByRole("button", { name: "Delete file" }));
  expect(onConfirm).toHaveBeenCalled();
});
