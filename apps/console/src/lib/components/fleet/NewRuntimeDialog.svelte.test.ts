/**
 * NewRuntimeDialog.svelte.test.ts
 *
 * TDD tests for the "New runtime" provisioning dialog.
 * RED → implement NewRuntimeDialog.svelte → GREEN.
 *
 * Mocks $lib/api/client; asserts:
 *   - renders provider select trigger (showing default first provider)
 *   - renders name input and tier select trigger
 *   - Create is disabled when name is empty
 *   - filling name + clicking Create calls provisionRuntime with correct values;
 *     on success onCreated + onClose fire
 *   - failed provisionRuntime shows inline error and does NOT call onClose
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import NewRuntimeDialog from "./NewRuntimeDialog.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const mockRuntime = {
  id: "rt_1",
  ownerId: "u1",
  provider: "docker" as const,
  externalId: null,
  status: "provisioning" as const,
  nodeId: null,
  name: "my-box",
  resourceTier: "small" as const,
  harness: "none" as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

test("renders provider select trigger showing the first provider from prop", () => {
  const { getByText } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["docker", "cloudflare"],
      onClose: vi.fn(),
    },
  });

  // The trigger shows the default selected value (first provider)
  expect(getByText("docker")).toBeTruthy();
});

test("renders name input and tier select", () => {
  const { getByPlaceholderText, getByText } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["docker"],
      onClose: vi.fn(),
    },
  });

  expect(getByPlaceholderText("Runtime name")).toBeTruthy();
  // Tier select trigger shows default "small"
  expect(getByText("small")).toBeTruthy();
});

test("Create button is disabled when name is empty", () => {
  const { getByRole } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["docker"],
      onClose: vi.fn(),
    },
  });

  const createBtn = getByRole("button", { name: /^create runtime$/i }) as HTMLButtonElement;
  expect(createBtn.disabled).toBe(true);
});

test("filling name and clicking Create calls provisionRuntime with correct values; onCreated + onClose fire on success", async () => {
  vi.spyOn(api, "provisionRuntime").mockResolvedValue(mockRuntime);
  const onClose = vi.fn();
  const onCreated = vi.fn();

  const { getByRole, getByPlaceholderText } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["docker", "cloudflare"],
      onClose,
      onCreated,
    },
  });

  // Fill in the name input
  const nameInput = getByPlaceholderText("Runtime name");
  fireEvent.input(nameInput, { target: { value: "my-box" } });

  // Create button should be enabled now (provider defaults to "docker", tier defaults to "small")
  const createBtn = getByRole("button", { name: /^create runtime$/i }) as HTMLButtonElement;
  await waitFor(() => expect(createBtn.disabled).toBe(false));

  fireEvent.click(createBtn);

  await waitFor(() => {
    expect(api.provisionRuntime).toHaveBeenCalledWith({
      provider: "docker",
      name: "my-box",
      resourceTier: "small",
      harness: "none",
    });
    expect(onCreated).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

test("harness select renders with Generic (none) as default", () => {
  const { getByText } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["docker"],
      onClose: vi.fn(),
    },
  });

  // The harness trigger shows the default label "Generic"
  expect(getByText("Generic")).toBeTruthy();
});

test("provisionRuntime is called with harness field (default none) when creating", async () => {
  vi.spyOn(api, "provisionRuntime").mockResolvedValue(mockRuntime);
  const onClose = vi.fn();

  const { getByRole, getByPlaceholderText } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["docker"],
      onClose,
    },
  });

  const nameInput = getByPlaceholderText("Runtime name");
  fireEvent.input(nameInput, { target: { value: "test-box" } });

  const createBtn = getByRole("button", { name: /^create runtime$/i }) as HTMLButtonElement;
  await waitFor(() => expect(createBtn.disabled).toBe(false));

  fireEvent.click(createBtn);

  await waitFor(() => {
    const call = (api.provisionRuntime as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toHaveProperty("harness");
    expect(call.harness).toBe("none");
  });
});

test("failed provisionRuntime shows inline error and does NOT call onClose", async () => {
  vi.spyOn(api, "provisionRuntime").mockRejectedValue(new Error("provider quota exceeded"));
  const onClose = vi.fn();
  const onCreated = vi.fn();

  const { getByRole, getByPlaceholderText, getByText } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["docker"],
      onClose,
      onCreated,
    },
  });

  const nameInput = getByPlaceholderText("Runtime name");
  fireEvent.input(nameInput, { target: { value: "fail-box" } });

  const createBtn = getByRole("button", { name: /^create runtime$/i }) as HTMLButtonElement;
  await waitFor(() => expect(createBtn.disabled).toBe(false));

  fireEvent.click(createBtn);

  await waitFor(() => {
    expect(getByText("provider quota exceeded")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
