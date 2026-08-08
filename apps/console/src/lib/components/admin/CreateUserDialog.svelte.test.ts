/**
 * CreateUserDialog.svelte.test.ts
 *
 * TDD tests for the shared create-user dialog (extracted from the admin
 * users list page's create-user form, now with client-side validation that
 * didn't exist before: email format + password minlength 8, surfaced via
 * Field `error`).
 * RED → implement CreateUserDialog.svelte → GREEN.
 *
 * This dialog is list-page-only, so importing `createUser` from
 * $lib/api/admin is fine (unlike Ban/RoleDialog, which must not).
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";

vi.mock("svelte-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("$lib/api/admin", () => ({
  createUser: vi.fn(),
}));

import * as adminApi from "$lib/api/admin";
import CreateUserDialog from "./CreateUserDialog.svelte";

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function fillForm(
  getByLabelText: (m: RegExp) => HTMLElement,
  values: { name?: string; email?: string; password?: string }
) {
  if (values.name !== undefined) {
    fireEvent.input(getByLabelText(/name/i), { target: { value: values.name } });
  }
  if (values.email !== undefined) {
    fireEvent.input(getByLabelText(/email/i), { target: { value: values.email } });
  }
  if (values.password !== undefined) {
    fireEvent.input(getByLabelText(/password/i), { target: { value: values.password } });
  }
}

test("open renders name, email, and password fields", () => {
  const { getByLabelText } = render(CreateUserDialog, {
    props: { open: true, onCreated: vi.fn() },
  });
  expect(getByLabelText(/name/i)).toBeTruthy();
  expect(getByLabelText(/email/i)).toBeTruthy();
  expect(getByLabelText(/password/i)).toBeTruthy();
});

test("submitting an invalid email blocks the call and shows a field error", async () => {
  const { getByLabelText, getByRole, getByText } = render(CreateUserDialog, {
    props: { open: true, onCreated: vi.fn() },
  });

  fillForm(getByLabelText, { name: "Jo", email: "not-an-email", password: "longenough" });

  const submitBtn = getByRole("button", { name: /create user/i });
  await fireEvent.click(submitBtn);

  await waitFor(() => {
    expect(getByText(/valid email/i)).toBeTruthy();
    expect(adminApi.createUser).not.toHaveBeenCalled();
  });
});

test("submitting a short password blocks the call and shows a field error", async () => {
  const { getByLabelText, getByRole, getByText } = render(CreateUserDialog, {
    props: { open: true, onCreated: vi.fn() },
  });

  fillForm(getByLabelText, { name: "Jo", email: "jo@example.com", password: "short" });

  const submitBtn = getByRole("button", { name: /create user/i });
  await fireEvent.click(submitBtn);

  await waitFor(() => {
    expect(getByText(/8 characters/i)).toBeTruthy();
    expect(adminApi.createUser).not.toHaveBeenCalled();
  });
});

test("valid submission calls createUser with the entered values and fires onCreated", async () => {
  vi.mocked(adminApi.createUser).mockResolvedValue({} as never);
  const onCreated = vi.fn();

  const { getByLabelText, getByRole } = render(CreateUserDialog, {
    props: { open: true, onCreated },
  });

  fillForm(getByLabelText, { name: "Jo Doe", email: "jo@example.com", password: "longenough" });

  const submitBtn = getByRole("button", { name: /create user/i });
  await fireEvent.click(submitBtn);

  await waitFor(() => {
    expect(adminApi.createUser).toHaveBeenCalledWith({
      email: "jo@example.com",
      password: "longenough",
      name: "Jo Doe",
      role: "user",
    });
    expect(onCreated).toHaveBeenCalledOnce();
  });
});
