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
import { apiError } from "$lib/api/http-error";
import AssignAgent from "./AssignAgent.svelte";

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const station = { id: "st_2", displayName: "Kubera", nodeName: "vps1" };

const candidates = [
  {
    principal: { id: "prn_stranded", kind: "agent" as const, handle: "stranded-writer", displayName: null, userId: null, suspendedAt: null },
    currentStation: null,
  },
  {
    principal: {
      id: "prn_suspended",
      kind: "agent" as const,
      handle: "suspended-writer",
      displayName: null,
      userId: null,
      suspendedAt: "2026-08-30T00:00:00Z",
    },
    currentStation: null,
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

test("a suspended principal is offered, not silently hidden — and the hub's real refusal reaches the operator", async () => {
  // Fix-round correction: this used to mock a hand-written
  // `new Error("Principal is suspended.")` directly on `assignStationAgent`,
  // which proved nothing about whether the hub's actual wire body survives
  // the API layer — it could have drifted from `apiError`/`asSentence` in
  // `http-error.ts` (or from `agents-admin.ts`'s own sentence) without this
  // test ever noticing. This runs the hub's REAL 403 body —
  // `{ error: "principal is suspended" }`, lowercase, no punctuation, exactly
  // as `agents-admin.ts:147` sends it — through the REAL `apiError()` this
  // codebase's `http()` calls on every failed request, and uses THAT derived
  // `ApiError` as what the mocked call rejects with. jsdom in this suite has
  // no `window.localStorage` (the same gap `NodesOverview.svelte.test.ts`
  // hits), which is what `http()` itself needs to resolve a base URL before
  // it would ever reach `fetch` — so the pipeline is exercised directly
  // rather than through a live `fetch` stub.
  const hubResponse = new Response(JSON.stringify({ error: "principal is suspended" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
  const refusal = await apiError(hubResponse, "PUT /api/admin/stations/st_2/agent");
  // Drift guard: if `asSentence` ever changes how it reads a hub body, this
  // fails here rather than silently agreeing with whatever it now produces.
  expect(refusal.message).toBe("Principal is suspended.");

  vi.mocked(agentsApi.assignStationAgent).mockRejectedValue(refusal);
  const onAssigned = vi.fn();

  const { getByRole, getByText } = render(AssignAgent, {
    props: { open: true, station, candidates, onAssigned },
  });

  // It is selectable at all — that is the "not silently offerable" part:
  // the refusal, not an absent option, is what tells the operator no.
  await pickAgent(getByRole, /suspended-writer/i);
  await fireEvent.click(getByRole("button", { name: /^assign$/i }));

  await waitFor(() => {
    expect(getByText(refusal.message)).toBeTruthy();
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

test("an already-occupied agent is offered too, labelled with the station it is moving from", async () => {
  // Fix round: occupancy is exclusive now, so the hub's assign endpoint
  // vacates a principal's previous station itself — offering an occupied
  // agent is a real move, not a silent double-assignment.
  const occupiedElsewhere = [
    ...candidates,
    {
      principal: { id: "prn_busy", kind: "agent" as const, handle: "busy-writer", displayName: null, userId: null, suspendedAt: null },
      currentStation: { id: "st_9", displayName: "Hanuman" },
    },
  ];
  vi.mocked(agentsApi.assignStationAgent).mockResolvedValue({ stationId: "st_2", principalId: "prn_busy" });
  const onAssigned = vi.fn();

  const { getByRole } = render(AssignAgent, {
    props: { open: true, station, candidates: occupiedElsewhere, onAssigned },
  });

  // The label names where it is moving FROM — so the operator sees a move,
  // not a spare agent conjured from nowhere.
  await pickAgent(getByRole, /busy-writer — moving from hanuman/i);
  await fireEvent.click(getByRole("button", { name: /^assign$/i }));

  await waitFor(() => {
    expect(agentsApi.assignStationAgent).toHaveBeenCalledWith("st_2", "prn_busy");
    expect(onAssigned).toHaveBeenCalledWith({
      principal: expect.objectContaining({ id: "prn_busy" }),
      stationId: "st_2",
    });
  });
});

test("the agent already at THIS station is not offered — reassigning it to itself is not a move", async () => {
  const alreadyHere = [
    ...candidates,
    {
      principal: { id: "prn_here", kind: "agent" as const, handle: "here-writer", displayName: null, userId: null, suspendedAt: null },
      currentStation: { id: station.id, displayName: station.displayName },
    },
  ];

  const { getByRole, queryByRole } = render(AssignAgent, {
    props: { open: true, station, candidates: alreadyHere, onAssigned: vi.fn() },
  });

  const trigger = getByRole("button", { name: /^agent to assign$/i });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });
  await waitFor(() => expect(getByRole("option", { name: /stranded-writer/i })).toBeTruthy());
  expect(queryByRole("option", { name: /here-writer/i })).toBeNull();
});
