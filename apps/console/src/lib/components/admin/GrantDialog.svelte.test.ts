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
 *
 * A value is one agent's principal id. The namespaced, pattern-matched forms
 * this dialog used to ask for — `agentpod:<node>/<stationKey>`,
 * `kaambaan:<agentId>` — are deleted rather than deprecated, so they are
 * asserted here as REFUSALS: they are still written down in older notes and
 * still what someone would paste in first.
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
    setGrant: vi.fn(),
    deleteGrant: vi.fn(),
  };
});

import * as grantsApi from "$lib/api/grants";
import GrantDialog from "./GrantDialog.svelte";

const PRINCIPAL = { id: "prn_00000000000000000001", label: "jo@example.com" };
const QUILL = "prn_0123456789abcdef0123";
const ECHO = "prn_ffffffffffffffffffff";

function open(props: Record<string, unknown> = {}) {
  return render(GrantDialog, {
    props: {
      open: true,
      principal: PRINCIPAL,
      grant: { mayDispatch: [], mayGrantReach: false },
      agentOptions: [],
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
    grant: { mayDispatch: [QUILL, ECHO], mayGrantReach: true },
  });

  expect(getByText(QUILL)).toBeTruthy();
  expect(getByText(ECHO)).toBeTruthy();
});

test("refuses the namespaced form this box used to ask for", async () => {
  // The shape everyone still has written down, and the one that would be pasted
  // in first. It is deleted, not narrowed — so the message has to say the
  // grammar changed rather than that this particular value is malformed.
  const { getByLabelText, getByRole, findByText } = open();

  await addValue(getByLabelText, getByRole, "agentpod:molt-bot/hermes:*");

  expect(await findByText(/that form is gone/i)).toBeTruthy();
  await fireEvent.click(getByRole("button", { name: /save/i }));
  expect(grantsApi.setGrant).not.toHaveBeenCalled();
});

test("refuses a wildcard, which would store happily and match nothing", async () => {
  // The value someone types meaning "all of them". Matching is equality now, so
  // stored it permits nobody while reading exactly like a working grant.
  const { getByLabelText, getByRole, findByText } = open();

  await addValue(getByLabelText, getByRole, "*");

  expect(await findByText(/wildcards match nothing/i)).toBeTruthy();
});

test("refuses anything that is not a well-formed principal id", async () => {
  const { getByLabelText, getByRole, findByText } = open();

  await addValue(getByLabelText, getByRole, "hermes");

  expect(await findByText(/must be a principal id/i)).toBeTruthy();
});

test("refuses a principal id one character short of the grammar", async () => {
  // The same length the mint site pins. A truncated id names nothing that was
  // ever minted, and it is the typo a copy-paste actually produces.
  const { getByLabelText, getByRole, findByText } = open();

  await addValue(getByLabelText, getByRole, "prn_0123456789abcdef012");

  expect(await findByText(/must be a principal id/i)).toBeTruthy();
});

test("saves the whole grant, so removing a value actually narrows it", async () => {
  // Whole-object on purpose: an authorization surface must never be easier to
  // widen than to narrow. A merge would make removal the harder operation.
  const onSaved = vi.fn();
  const { getByRole, getAllByRole } = open({
    grant: {
      mayDispatch: [QUILL, ECHO],
      mayGrantReach: false,
    },
    onSaved,
  });

  await fireEvent.click(getAllByRole("button", { name: /remove value/i })[0]!);
  await fireEvent.click(getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(grantsApi.setGrant).toHaveBeenCalledWith(PRINCIPAL.id, {
      mayDispatch: [ECHO],
      mayGrantReach: false,
    })
  );
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
});

test("adds a valid value and carries it into the save", async () => {
  const { getByLabelText, getByRole } = open();

  await addValue(getByLabelText, getByRole, QUILL);
  await fireEvent.click(getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(grantsApi.setGrant).toHaveBeenCalledWith(PRINCIPAL.id, {
      mayDispatch: [QUILL],
      mayGrantReach: false,
    })
  );
});

test("a suggested agent is added by its id, never by the name shown on it", async () => {
  // The label is what a person recognises; the id is what is compared by
  // equality. Storing the label would be a grant that matches nothing.
  const { getByRole } = open({
    agentOptions: [{ id: QUILL, label: "Quill" }],
  });

  await fireEvent.click(getByRole("button", { name: /\+ Quill/ }));
  await fireEvent.click(getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(grantsApi.setGrant).toHaveBeenCalledWith(PRINCIPAL.id, {
      mayDispatch: [QUILL],
      mayGrantReach: false,
    })
  );
});

test("does not add the same value twice", async () => {
  // A duplicate grants nothing extra and makes the list harder to read, which is
  // how an over-wide grant hides in plain sight.
  const { getByLabelText, getByRole, getAllByText } = open({
    grant: { mayDispatch: [QUILL], mayGrantReach: false },
  });

  await addValue(getByLabelText, getByRole, QUILL);

  expect(getAllByText(QUILL)).toHaveLength(1);
});

test("an empty grant is savable, because 'permitted nothing' is a real decision", async () => {
  const { getByRole } = open({
    grant: { mayDispatch: [QUILL], mayGrantReach: false },
  });

  await fireEvent.click(getByRole("button", { name: /remove value/i }));
  await fireEvent.click(getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(grantsApi.setGrant).toHaveBeenCalledWith(PRINCIPAL.id, {
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

  await addValue(getByLabelText, getByRole, QUILL);
  await fireEvent.click(getByRole("button", { name: /save/i }));

  const { toast } = await import("svelte-sonner");
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(getByText(QUILL)).toBeTruthy();
});
