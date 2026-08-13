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

// bits-ui's Select opens on `pointerdown` (not `click`) and picks an item on
// `pointerup`, and touches `hasPointerCapture`/`releasePointerCapture` along
// the way — jsdom implements neither a `PointerEvent` constructor nor those
// capture methods. Same polyfill as UserFilters.svelte.test.ts, scoped here.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "mouse";
    }
  }
  // @ts-expect-error jsdom has no native PointerEvent
  window.PointerEvent = PointerEventPolyfill;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}

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

test("offers a provider the console has never heard of, if the hub reports it", async () => {
  // The point of the registry: adding a driver must not require a console edit.
  // "fly" appears in no list in this repo — it is offered because the hub said
  // so, and its tier list comes from the manifest the hub sent with it.
  const { getByText, queryByText } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["fly"],
      manifests: [{ provider: "fly", supportedTiers: ["medium"], imageBinding: "per-instance" }],
      onClose: () => {},
      onCreated: () => {},
    },
  });

  expect(getByText("fly")).toBeTruthy();
  // The tier defaults to the one this unknown provider declared, not "small".
  expect(getByText("medium")).toBeTruthy();
  expect(queryByText("small")).toBeNull();
});

test("offers only the tiers the selected provider can actually satisfy", async () => {
  // Cloudflare fixes instance_type at worker deploy time, so it supports one
  // tier. Offering small/medium/large made provisioning fail with a backend
  // error as the only feedback — the dialog must not present a doomed choice.
  const { getByText, queryByText } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["cloudflare"],
      manifests: [
        { provider: "cloudflare", supportedTiers: ["large"], imageBinding: "fixed" },
      ],
      onClose: () => {},
      onCreated: () => {},
    },
  });

  // The trigger shows the selected tier, which must already be a supported one.
  expect(getByText("large")).toBeTruthy();
  expect(queryByText("small")).toBeNull();
  expect(queryByText("medium")).toBeNull();
});

test("defaults the tier to one the provider supports", async () => {
  // The default was hardcoded to "small", which cloudflare refuses.
  const spy = vi.spyOn(api, "provisionRuntime").mockResolvedValue({
    ...mockRuntime,
    provider: "cloudflare" as const,
    resourceTier: "large" as const,
  });

  const { getByRole, getByPlaceholderText } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["cloudflare"],
      manifests: [
        { provider: "cloudflare", supportedTiers: ["large"], imageBinding: "fixed" },
      ],
      onClose: () => {},
      onCreated: () => {},
    },
  });

  const input = getByPlaceholderText(/my-runtime|name/i);
  await fireEvent.input(input, { target: { value: "cf-box" } });
  await fireEvent.click(getByRole("button", { name: /^create runtime$/i }));

  await waitFor(() =>
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "cloudflare", resourceTier: "large" })
    )
  );
});

// ─── Harness-aware tiers (issue #279) ────────────────────────────────────────
//
// Fly's `small` is 1 GB. Measured on a real machine on 2026-08-13: one OpenCode
// chat turn peaked at 855 MB of harness on top of ~157 MB of OS and node-agent,
// leaving 58 MB — and `POST /acp/sessions` 502'd after 34s. The dialog offered
// that combination because tiers were advertised per PROVIDER, with no regard
// for the harness that has to fit inside one.

/** What the hub now reports for a provider with all three tiers. */
const FLY_MANIFEST: api.DriverManifest = {
  provider: "fly",
  supportedTiers: ["small", "medium", "large"],
  tierMemoryMb: { small: 1024, medium: 2048, large: 4096 },
  harnessTiers: {
    none: ["small", "medium", "large"],
    opencode: ["medium", "large"],
    pi: ["small", "medium", "large"],
  },
  imageBinding: "per-instance",
};

/** The Select trigger for a field, by the id the dialog labels it with. */
function trigger(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no select trigger #${id}`);
  return el;
}

/** Opens a bits-ui Select (pointerdown) and returns its rendered options. */
async function openSelect(id: string): Promise<HTMLElement[]> {
  await fireEvent.pointerDown(trigger(id), { pointerId: 1, button: 0, pointerType: "mouse" });
  return await waitFor(() => {
    const found = [...document.querySelectorAll('[role="option"]')] as HTMLElement[];
    expect(found.length).toBeGreaterThan(0);
    return found;
  });
}

/** Opens a Select and picks the option whose text matches. */
async function pick(id: string, label: RegExp) {
  const options = await openSelect(id);
  const option = options.find((o) => label.test(o.textContent?.trim() ?? ""));
  if (!option) {
    throw new Error(
      `no option matching ${label} in #${id} — saw ${options.map((o) => o.textContent?.trim())}`
    );
  }
  await fireEvent.pointerUp(option, { pointerId: 1, button: 0, pointerType: "mouse" });
}

test("does not offer a tier the selected harness cannot run in", async () => {
  const { getByRole, getByText, queryByText } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["fly"],
      manifests: [FLY_MANIFEST],
      onClose: () => {},
      onCreated: () => {},
    },
  });

  // With the generic harness every tier is legitimate, `small` included.
  expect(getByText("small")).toBeTruthy();

  await pick("runtime-harness", /^opencode$/i);

  // The tier picker must now narrow, and the selection must not be left on a
  // tier that has just become impossible.
  await waitFor(() => expect(queryByText("small")).toBeNull());
  expect(getByText("medium")).toBeTruthy();

  // And the list itself, not merely the current selection.
  const options = await openSelect("runtime-tier");
  expect(options.map((o) => o.textContent?.trim())).toEqual(["medium", "large"]);
});

test("provisions the corrected tier after the harness narrows the choice", async () => {
  // The payload, not just the pixels: a dialog that renders a narrowed list but
  // posts the stale `small` it was showing before is exactly the bug.
  const spy = vi.spyOn(api, "provisionRuntime").mockResolvedValue({
    ...mockRuntime,
    provider: "fly",
    resourceTier: "medium" as const,
    harness: "opencode" as const,
  });

  const { getByRole, getByPlaceholderText } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["fly"],
      manifests: [FLY_MANIFEST],
      onClose: () => {},
      onCreated: () => {},
    },
  });

  await pick("runtime-harness", /^opencode$/i);

  await fireEvent.input(getByPlaceholderText("Runtime name"), {
    target: { value: "fly-box" },
  });
  await fireEvent.click(getByRole("button", { name: /^create runtime$/i }));

  await waitFor(() =>
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "fly", harness: "opencode", resourceTier: "medium" })
    )
  );
});

test("says so, and refuses to create, when no tier can run the harness", async () => {
  // Cloudflare bakes instance_type into the worker at deploy. A worker deployed
  // `small` cannot run OpenCode at all, and the honest answer is to say that
  // rather than to offer the only size it has.
  const spy = vi.spyOn(api, "provisionRuntime");

  const { getByRole, getByPlaceholderText, getByText } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["cloudflare"],
      manifests: [
        {
          provider: "cloudflare",
          supportedTiers: ["small"],
          tierMemoryMb: { small: 1024 },
          harnessTiers: { none: ["small"], opencode: [], pi: ["small"] },
          imageBinding: "fixed",
        },
      ],
      onClose: () => {},
      onCreated: () => {},
    },
  });

  await pick("runtime-harness", /^opencode$/i);

  await fireEvent.input(getByPlaceholderText("Runtime name"), {
    target: { value: "cf-box" },
  });

  await waitFor(() => expect(getByText(/no cloudflare tier can run opencode/i)).toBeTruthy());
  const createBtn = getByRole("button", { name: /^create runtime$/i }) as HTMLButtonElement;
  expect(createBtn.disabled).toBe(true);
  await fireEvent.click(createBtn);
  expect(spy).not.toHaveBeenCalled();
});

test("falls back to the provider's tiers when the hub is too old to narrow them", async () => {
  // Hub and console deploy separately. A hub that does not send harnessTiers
  // must not blank the tier picker — the hub's own refusal is the backstop.
  const { getByRole, getByText } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["fly"],
      manifests: [{ provider: "fly", supportedTiers: ["small", "medium", "large"] }],
      onClose: () => {},
      onCreated: () => {},
    },
  });

  await pick("runtime-harness", /^opencode$/i);

  expect(getByText("small")).toBeTruthy();
});
