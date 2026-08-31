/**
 * AssignAgent.svelte.test.ts
 *
 * TDD tests for Ruling 6's control: putting an EXISTING agent principal into
 * a station. `AgentCreate.svelte` wired `assignStationAgent`'s only caller —
 * minting a brand-new agent and handing it a station in one click — leaving
 * no way to put a previously-existing (or just-unassigned) principal
 * anywhere. This is that way back.
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";

// bits-ui's Select opens on `pointerdown` (not `click`) and picks an item on
// `pointerup`, and touches `hasPointerCapture`/`releasePointerCapture` along
// the way — jsdom implements neither. Same polyfill as AgentCreate.svelte.test.ts.
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

vi.mock("$lib/api/agents", async () => {
  const actual = await vi.importActual<typeof import("$lib/api/agents")>("$lib/api/agents");
  return {
    ...actual,
    assignStationAgent: vi.fn(),
  };
});

import * as agentsApi from "$lib/api/agents";
import AssignAgent from "./AssignAgent.svelte";

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const station = { id: "st_2", displayName: "Kubera", nodeName: "vps1" };

const candidates = [
  { id: "prn_stranded", kind: "agent" as const, handle: "stranded-writer", displayName: null, userId: null, suspendedAt: null },
  {
    id: "prn_suspended",
    kind: "agent" as const,
    handle: "suspended-writer",
    displayName: null,
    userId: null,
    suspendedAt: "2026-08-30T00:00:00Z",
  },
];

async function pickAgent(
  getByRole: (role: string, options: { name: RegExp }) => HTMLElement,
  name: RegExp
) {
  // Accessible name comes from the Field's associated <label>, not the
  // trigger's own placeholder text — same as AgentCreate.svelte.test.ts's
  // station picker.
  const trigger = getByRole("button", { name: /^agent to assign$/i });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });
  const option = await waitFor(() => getByRole("option", { name }));
  await fireEvent.pointerUp(option, { pointerId: 1, button: 0, pointerType: "mouse" });
}

test("picking an agent and submitting calls assignStationAgent and reports it, and the station ends up occupied", async () => {
  vi.mocked(agentsApi.assignStationAgent).mockResolvedValue({ stationId: "st_2", principalId: "prn_stranded" });
  const onAssigned = vi.fn();

  const { getByRole } = render(AssignAgent, {
    props: { open: true, station, candidates, onAssigned },
  });

  await pickAgent(getByRole, /stranded-writer/i);
  await fireEvent.click(getByRole("button", { name: /^assign$/i }));

  await waitFor(() => {
    expect(agentsApi.assignStationAgent).toHaveBeenCalledWith("st_2", "prn_stranded");
    expect(onAssigned).toHaveBeenCalledWith({
      principal: expect.objectContaining({ id: "prn_stranded" }),
      stationId: "st_2",
    });
  });
});

test("the submit button stays disabled until an agent is picked", () => {
  const { getByRole } = render(AssignAgent, {
    props: { open: true, station, candidates, onAssigned: vi.fn() },
  });

  expect((getByRole("button", { name: /^assign$/i }) as HTMLButtonElement).disabled).toBe(true);
});

test("a suspended principal is offered, not silently hidden — and the hub's 403 reaches the operator", async () => {
  vi.mocked(agentsApi.assignStationAgent).mockRejectedValue(new Error("Principal is suspended."));
  const onAssigned = vi.fn();

  const { getByRole, getByText } = render(AssignAgent, {
    props: { open: true, station, candidates, onAssigned },
  });

  // It is selectable at all — that is the "not silently offerable" part:
  // the refusal, not an absent option, is what tells the operator no.
  await pickAgent(getByRole, /suspended-writer/i);
  await fireEvent.click(getByRole("button", { name: /^assign$/i }));

  await waitFor(() => {
    expect(agentsApi.assignStationAgent).toHaveBeenCalledWith("st_2", "prn_suspended");
    expect(getByText("Principal is suspended.")).toBeTruthy();
  });
  expect(onAssigned).not.toHaveBeenCalled();
});

test("no available agents says so and offers no picker", () => {
  const { getByTestId, queryByRole } = render(AssignAgent, {
    props: { open: true, station, candidates: [], onAssigned: vi.fn() },
  });

  expect(getByTestId("no-available-agents")).toBeTruthy();
  expect(queryByRole("button", { name: /^agent to assign$/i })).toBeNull();
});
