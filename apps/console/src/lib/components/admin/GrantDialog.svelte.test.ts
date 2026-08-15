/**
 * GrantDialog.svelte.test.ts
 *
 * Editing the control pair — who may dispatch which agent, and who may grant an
 * agent its reach (`charter` → `decisions/2026-08-13-ecosystem-identity.md`).
 *
 * The stakes here are not the usual form stakes. A grant that stores happily and
 * matches nothing reads exactly like a working grant, and the person who wrote it
 * believes an agent is reachable when it is not — or, worse, believes the fleet
 * is narrowed when the value they typed narrowed nothing. So most of what is
 * asserted below is about **refusing** values, and about the save being a
 * replacement rather than a merge.
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";

vi.mock("svelte-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("$lib/api/grants", async () => {
  const actual = await vi.importActual<typeof import("$lib/api/grants")>("$lib/api/grants");
  return {
    // The validator is pure and shared with the server's rule — mocking it would
    // test a stub instead of the thing that decides.
    grantValueProblem: actual.grantValueProblem,
    KNOWN_PLANES: actual.KNOWN_PLANES,
    setGrant: vi.fn(),
    deleteGrant: vi.fn(),
  };
});

import * as grantsApi from "$lib/api/grants";
import GrantDialog from "./GrantDialog.svelte";

const PRINCIPAL = { id: "user_abc", label: "jo@example.com" };

function open(props: Record<string, unknown> = {}) {
  return render(GrantDialog, {
    props: {
      open: true,
      principal: PRINCIPAL,
      grant: { mayDispatch: [], mayGrantReach: false },
      stationValues: [],
      onSaved: vi.fn(),
      ...props,
    },
  });
}

async function addValue(getByLabelText: (m: RegExp) => HTMLElement, getByRole: any, value: string) {
  await fireEvent.input(getByLabelText(/add a value/i), { target: { value } });
  await fireEvent.click(getByRole("button", { name: /^add$/i }));
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

test("shows the values the principal already has", () => {
  const { getByText } = open({
    grant: { mayDispatch: ["agentpod:molt-bot/hermes:*", "kaambaan:agt_7abf"], mayGrantReach: true },
  });

  expect(getByText("agentpod:molt-bot/hermes:*")).toBeTruthy();
  expect(getByText("kaambaan:agt_7abf")).toBeTruthy();
});

test("refuses an AgentPod value that names no node", async () => {
  // The shape everyone writes first. Station keys repeat across nodes, so this
  // matches nothing anywhere — and stored, it looks like a working grant.
  const { getByLabelText, getByRole, findByText } = open();

  await addValue(getByLabelText, getByRole, "agentpod:hermes:*");

  expect(await findByText(/must name a node/i)).toBeTruthy();
  await fireEvent.click(getByRole("button", { name: /save/i }));
  expect(grantsApi.setGrant).not.toHaveBeenCalled();
});

test("refuses a value that names no plane", async () => {
  const { getByLabelText, getByRole, findByText } = open();

  await addValue(getByLabelText, getByRole, "hermes:*");

  expect(await findByText(/must name a plane/i)).toBeTruthy();
});

test("saves the whole grant, so removing a value actually narrows it", async () => {
  // Whole-object on purpose: an authorization surface must never be easier to
  // widen than to narrow. A merge would make removal the harder operation.
  const onSaved = vi.fn();
  const { getByRole, getAllByRole } = open({
    grant: {
      mayDispatch: ["agentpod:molt-bot/hermes:*", "kaambaan:agt_7abf"],
      mayGrantReach: false,
    },
    onSaved,
  });

  await fireEvent.click(getAllByRole("button", { name: /remove value/i })[0]!);
  await fireEvent.click(getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(grantsApi.setGrant).toHaveBeenCalledWith("user_abc", {
      mayDispatch: ["kaambaan:agt_7abf"],
      mayGrantReach: false,
    })
  );
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
});

test("adds a valid value and carries it into the save", async () => {
  const { getByLabelText, getByRole } = open();

  await addValue(getByLabelText, getByRole, "agentpod:*/hermes:*");
  await fireEvent.click(getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(grantsApi.setGrant).toHaveBeenCalledWith("user_abc", {
      mayDispatch: ["agentpod:*/hermes:*"],
      mayGrantReach: false,
    })
  );
});

test("does not add the same value twice", async () => {
  // A duplicate grants nothing extra and makes the list harder to read, which is
  // how an over-wide grant hides in plain sight.
  const { getByLabelText, getByRole, getAllByText } = open({
    grant: { mayDispatch: ["kaambaan:agt_7abf"], mayGrantReach: false },
  });

  await addValue(getByLabelText, getByRole, "kaambaan:agt_7abf");

  expect(getAllByText("kaambaan:agt_7abf")).toHaveLength(1);
});

test("an empty grant is savable, because 'permitted nothing' is a real decision", async () => {
  const { getByRole } = open({
    grant: { mayDispatch: ["kaambaan:agt_7abf"], mayGrantReach: false },
  });

  await fireEvent.click(getByRole("button", { name: /remove value/i }));
  await fireEvent.click(getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(grantsApi.setGrant).toHaveBeenCalledWith("user_abc", {
      mayDispatch: [],
      mayGrantReach: false,
    })
  );
});

test("a failed save keeps the dialog open with the edits intact", async () => {
  // Losing a half-written grant to a network blip is how people end up applying
  // a wider one the second time, just to be done with it.
  vi.mocked(grantsApi.setGrant).mockRejectedValueOnce(new Error("hub unreachable"));
  const { getByLabelText, getByRole, getByText } = open();

  await addValue(getByLabelText, getByRole, "kaambaan:agt_7abf");
  await fireEvent.click(getByRole("button", { name: /save/i }));

  const { toast } = await import("svelte-sonner");
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(getByText("kaambaan:agt_7abf")).toBeTruthy();
});
