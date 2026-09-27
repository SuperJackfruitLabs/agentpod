/**
 * AgentCreate.svelte.test.ts
 *
 * TDD tests for the create-and-assign dialog — the write half of "a station
 * with no principal is dispatchable by nobody, and today that is invisible".
 * RED → implement AgentCreate.svelte → GREEN.
 *
 * Two invocation shapes are covered:
 *  - a locked `station` prop ("Create an agent for this station"): the
 *    handle is pre-filled from the station key and the target isn't a choice.
 *  - `stationOptions` with no locked station (reachable from /agents):
 *    a picker among currently-unassigned stations, editable handle, still
 *    optional to assign at all.
 *
 * And the refusal this dialog exists to get right: a 409 must read as "that
 * handle is taken", not a generic failure.
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";

// bits-ui's Select opens on `pointerdown` (not `click`) and picks an item on
// `pointerup`, and touches `hasPointerCapture`/`releasePointerCapture` along
// the way — jsdom implements neither. Same polyfill as RoleDialog.svelte.test.ts.
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

vi.mock("svelte-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("$lib/api/agents", async () => {
  const actual = await vi.importActual<typeof import("$lib/api/agents")>("$lib/api/agents");
  return {
    ...actual,
    createAgent: vi.fn(),
    assignStationAgent: vi.fn(),
  };
});

import * as agentsApi from "$lib/api/agents";
import AgentCreate from "./AgentCreate.svelte";

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const station = { id: "st_1", stationKey: "hermes:writer-quill", displayName: "Writer Quill", nodeName: "vps1" };

test("a locked station pre-fills the handle from the station key", () => {
  const { getByLabelText } = render(AgentCreate, {
    props: { open: true, station, stationOptions: [], onCreated: vi.fn() },
  });

  const handleInput = getByLabelText(/handle/i) as HTMLInputElement;
  expect(handleInput.value).toBe("writer-quill");
});

test("the pre-filled handle stays editable before submitting", async () => {
  const { getByLabelText } = render(AgentCreate, {
    props: { open: true, station, stationOptions: [], onCreated: vi.fn() },
  });

  const handleInput = getByLabelText(/handle/i) as HTMLInputElement;
  await fireEvent.input(handleInput, { target: { value: "quill-2" } });
  expect(handleInput.value).toBe("quill-2");
});

test("creating for a locked station calls createAgent then assignStationAgent, and reports the assignment", async () => {
  vi.mocked(agentsApi.createAgent).mockResolvedValue({
    id: "prn_abc",
    kind: "agent",
    handle: "writer-quill",
    displayName: null,
    suspendedAt: null,
  });
  vi.mocked(agentsApi.assignStationAgent).mockResolvedValue({ stationId: "st_1", principalId: "prn_abc" });
  const onCreated = vi.fn();

  const { getByRole } = render(AgentCreate, {
    props: { open: true, station, stationOptions: [], onCreated },
  });

  await fireEvent.submit(getByRole("button", { name: /create/i }).closest("form")!);

  await waitFor(() => {
    expect(agentsApi.createAgent).toHaveBeenCalledWith({ handle: "writer-quill", displayName: undefined });
    expect(agentsApi.assignStationAgent).toHaveBeenCalledWith("st_1", "prn_abc");
    expect(onCreated).toHaveBeenCalledWith({ principal: expect.objectContaining({ id: "prn_abc" }), stationId: "st_1" });
  });
});

test("create succeeds but the assignment fails: the agent is reported created-but-unassigned, not lost", async () => {
  vi.mocked(agentsApi.createAgent).mockResolvedValue({
    id: "prn_abc",
    kind: "agent",
    handle: "writer-quill",
    displayName: null,
    suspendedAt: null,
  });
  vi.mocked(agentsApi.assignStationAgent).mockRejectedValue(new Error("Principal is suspended."));
  const { toast } = await import("svelte-sonner");
  const onCreated = vi.fn();

  const { getByRole } = render(AgentCreate, {
    props: { open: true, station, stationOptions: [], onCreated },
  });

  await fireEvent.submit(getByRole("button", { name: /create/i }).closest("form")!);

  await waitFor(() => {
    // The principal was minted — losing that from the caller's view would
    // strand an identity nobody can find again, and a retry would 409.
    expect(onCreated).toHaveBeenCalledWith({
      principal: expect.objectContaining({ id: "prn_abc" }),
      stationId: null,
    });
    // The refusal itself — not a generic failure — is what's reported.
    expect(toast.error).toHaveBeenCalledWith(
      "Agent created, but couldn't be assigned",
      expect.objectContaining({ description: "Principal is suspended." })
    );
  });
});

test("a taken handle surfaces the 409 as a readable message, not a generic failure", async () => {
  vi.mocked(agentsApi.createAgent).mockRejectedValue(new Error("Handle already taken."));

  const { getByLabelText, getByRole, getByText, queryByText } = render(AgentCreate, {
    props: { open: true, station, stationOptions: [], onCreated: vi.fn() },
  });

  await fireEvent.submit(getByRole("button", { name: /create/i }).closest("form")!);

  await waitFor(() => {
    expect(getByText("Handle already taken.")).toBeTruthy();
  });
  // The generic fallback copy must not be what the operator sees instead.
  expect(queryByText(/something went wrong/i)).toBeNull();
  // The dialog must not silently move on — the handle is still what's shown.
  expect((getByLabelText(/handle/i) as HTMLInputElement).value).toBe("writer-quill");
  expect(agentsApi.assignStationAgent).not.toHaveBeenCalled();
});

test("a mangled-handle 400 also surfaces the hub's own sentence", async () => {
  vi.mocked(agentsApi.createAgent).mockRejectedValue(
    new Error("Handle would be altered when built into a matrix address; choose one clean() leaves unchanged.")
  );

  const { getByRole, getByText } = render(AgentCreate, {
    props: { open: true, station, stationOptions: [], onCreated: vi.fn() },
  });

  await fireEvent.submit(getByRole("button", { name: /create/i }).closest("form")!);

  await waitFor(() => {
    expect(getByText(/choose one clean\(\) leaves unchanged/i)).toBeTruthy();
  });
});

test("no station prop and no stationOptions: creates unassigned and explains there's nothing to assign to yet", async () => {
  vi.mocked(agentsApi.createAgent).mockResolvedValue({
    id: "prn_xyz",
    kind: "agent",
    handle: "quill",
    displayName: null,
    suspendedAt: null,
  });
  const onCreated = vi.fn();

  const { getByLabelText, getByRole, getByText } = render(AgentCreate, {
    props: { open: true, station: null, stationOptions: [], onCreated },
  });

  expect(getByText(/no unassigned station/i)).toBeTruthy();

  await fireEvent.input(getByLabelText(/handle/i), { target: { value: "quill" } });
  await fireEvent.submit(getByRole("button", { name: /create/i }).closest("form")!);

  await waitFor(() => {
    expect(agentsApi.createAgent).toHaveBeenCalledWith({ handle: "quill", displayName: undefined });
    expect(agentsApi.assignStationAgent).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith({ principal: expect.objectContaining({ id: "prn_xyz" }), stationId: null });
  });
});

test("picking a station from stationOptions pre-fills the handle from its key, and picking a different one replaces it while untouched", async () => {
  const options = [
    { id: "st_1", stationKey: "hermes:writer-quill", displayName: "Writer Quill", nodeName: "vps1" },
    { id: "st_2", stationKey: "openclaw:kubera", displayName: "Kubera", nodeName: "vps1" },
  ];

  const { getByLabelText, getByRole } = render(AgentCreate, {
    props: { open: true, station: null, stationOptions: options, onCreated: vi.fn() },
  });

  const trigger = getByRole("button", { name: /assign to station/i });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });
  const kuberaOption = await waitFor(() => getByRole("option", { name: /kubera/i }));
  await fireEvent.pointerUp(kuberaOption, { pointerId: 1, button: 0, pointerType: "mouse" });

  await waitFor(() => {
    expect((getByLabelText(/handle/i) as HTMLInputElement).value).toBe("kubera");
  });
});

test("the handle field says it cannot be changed after creation", () => {
  const { getByText } = render(AgentCreate, {
    props: { open: true, station, stationOptions: [], onCreated: vi.fn() },
  });

  expect(getByText(/can.?t (be )?change/i)).toBeTruthy();
});
