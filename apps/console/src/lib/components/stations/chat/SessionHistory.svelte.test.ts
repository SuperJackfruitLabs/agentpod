/**
 * SessionHistory.svelte.test.ts
 *
 * The station's full session history: a paginated, read-only list in a dialog.
 * The api layer is mocked (spies on $lib/api/acp) — no network is touched.
 *
 * Run: cd apps/console && pnpm test src/lib/components/stations/chat/SessionHistory
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor, within } from "@testing-library/svelte";
import type { AcpSessionRow } from "@agentpod/contract";
import * as api from "$lib/api/acp";

import SessionHistory from "./SessionHistory.svelte";

/** Matches the component's page size — the cue that a page was the last one. */
const PAGE_SIZE = 20;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** ISO timestamp `minutes` ago — keeps relative labels deterministic. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function row(over: Partial<AcpSessionRow> = {}): AcpSessionRow {
  return {
    id: "s1",
    stationId: "st1",
    userId: "u1",
    mode: "ask",
    status: "idle",
    endedReason: null,
    createdAt: "2026-08-09T00:00:00.000Z",
    lastEventAt: minutesAgo(5),
    title: null,
    lastSeq: 0,
    ...over,
  };
}

/** A full page (so the component keeps offering "Load older"). */
function fullPage(prefix: string, ageOffset = 0): AcpSessionRow[] {
  return Array.from({ length: PAGE_SIZE }, (_, i) =>
    row({
      id: `${prefix}${i}`,
      title: `${prefix} session ${i}`,
      lastEventAt: minutesAgo(ageOffset + i),
      lastSeq: i,
    }),
  );
}

function setup(rows: AcpSessionRow[], props: { currentSessionId?: string | null } = {}) {
  const list = vi.spyOn(api, "listAcpSessions").mockResolvedValue(rows);
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const utils = render(SessionHistory, {
    props: {
      stationId: "st1",
      currentSessionId: props.currentSessionId ?? null,
      onSelect,
      onClose,
    },
  });
  return { ...utils, list, onSelect, onClose };
}

/** The dialog element, once its first page has landed. */
async function dialogOf(u: { getByRole: (r: string) => HTMLElement }): Promise<HTMLElement> {
  return await waitFor(() => u.getByRole("dialog"));
}

// ─── Listing ────────────────────────────────────────────────────────────────

test("lists the station's sessions with title, status, activity and event count", async () => {
  const rows = [
    row({ id: "sa", title: "Fix the flaky terminal test", status: "idle", lastEventAt: minutesAgo(65), lastSeq: 12 }),
    row({ id: "sb", title: "Bump the node-agent version", status: "ended", lastEventAt: minutesAgo(150), lastSeq: 1 }),
  ];
  const u = setup(rows);

  const dialog = await dialogOf(u);
  await waitFor(() => expect(u.list).toHaveBeenCalledWith("st1", { limit: PAGE_SIZE }));

  const buttons = await waitFor(() => {
    const found = within(dialog)
      .getAllByRole("button")
      .filter((b) => b.textContent?.includes("session") || b.textContent?.includes("Fix") || b.textContent?.includes("Bump"));
    if (found.length < 2) throw new Error("rows not rendered yet");
    return found;
  });

  const first = buttons.find((b) => b.textContent?.includes("Fix the flaky terminal test"))!;
  expect(first.textContent).toContain("idle");
  expect(first.textContent).toContain("1h ago");
  expect(first.textContent).toContain("12 events");

  const second = buttons.find((b) => b.textContent?.includes("Bump the node-agent version"))!;
  expect(second.textContent).toContain("ended");
  expect(second.textContent).toContain("2h ago");
  expect(second.textContent).toContain("1 event");
  expect(second.textContent).not.toContain("1 events");
});

test("an untitled session falls back to 'Session N' — the same word the switcher uses — and titles are text only", async () => {
  // Same createdAt on sa/sb: the ordinal ties break on id, so sa=1, sb=2
  // regardless of sc (titled, and sorted between them by id) being present.
  const rows = [
    row({ id: "sa", title: null }),
    row({ id: "sb", title: "   " }),
    row({ id: "sc", title: "<img src=x onerror=alert(1)> & <b>bold</b>" }),
  ];
  const u = setup(rows);
  const dialog = await dialogOf(u);

  // Not "Untitled session" — the history dialog and the chat header's
  // switcher must agree on the fallback word for the same kind of row.
  expect(await waitFor(() => within(dialog).getByText("Session 1"))).toBeTruthy();
  expect(within(dialog).getByText("Session 2")).toBeTruthy(); // null and whitespace-only both fall back
  expect(within(dialog).queryByText("Untitled session")).toBeNull();

  // Untrusted text: the agent's / the user's own words never become markup.
  const nasty = within(dialog).getByText("<img src=x onerror=alert(1)> & <b>bold</b>");
  expect(nasty.querySelector("img")).toBeNull();
  expect(nasty.querySelector("b")).toBeNull();
});

test("a station with no sessions shows the empty state, not an empty list", async () => {
  const u = setup([]);
  const dialog = await dialogOf(u);

  await waitFor(() => expect(within(dialog).getByText("No sessions yet")).toBeTruthy());
  expect(within(dialog).queryByRole("button", { name: "Load older" })).toBeNull();
});

test("a failed load says so instead of looking empty, and can be retried", async () => {
  // A failed FIRST page has nothing to page from, so the "Load older" control
  // isn't rendered — without a retry here the only way out is closing and
  // reopening the dialog.
  const list = vi
    .spyOn(api, "listAcpSessions")
    .mockRejectedValue(new Error("Couldn't reach the hub."));
  const u = render(SessionHistory, {
    props: { stationId: "st1", currentSessionId: null, onSelect: vi.fn(), onClose: vi.fn() },
  });

  const dialog = await dialogOf(u);
  await waitFor(() => expect(within(dialog).getByText("Couldn't reach the hub.")).toBeTruthy());
  expect(within(dialog).queryByText("No sessions yet")).toBeNull();

  list.mockResolvedValue([row({ id: "sa", title: "back from the dead" })]);
  await fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));

  await waitFor(() => expect(within(dialog).getByText("back from the dead")).toBeTruthy());
  // The stale error goes with the successful retry.
  expect(within(dialog).queryByText("Couldn't reach the hub.")).toBeNull();
  expect(list).toHaveBeenLastCalledWith("st1", { limit: PAGE_SIZE });
});

// ─── Pagination ─────────────────────────────────────────────────────────────

test("Load older requests the next page with the compound cursor and appends it", async () => {
  const first = fullPage("first", 0);
  const u = setup(first);
  const dialog = await dialogOf(u);
  await waitFor(() => expect(within(dialog).getByText("first session 19")).toBeTruthy());

  const older = [row({ id: "old1", title: "ancient session", lastEventAt: minutesAgo(9000), lastSeq: 3 })];
  u.list.mockResolvedValue(older);

  await fireEvent.click(within(dialog).getByRole("button", { name: "Load older" }));

  // The cursor is the OLDEST row on screen — its timestamp AND its id, so a
  // group of sessions sharing a millisecond can't fall through the boundary.
  await waitFor(() =>
    expect(u.list).toHaveBeenLastCalledWith("st1", {
      limit: PAGE_SIZE,
      before: first.at(-1)!.lastEventAt,
      beforeId: first.at(-1)!.id,
    }),
  );
  await waitFor(() => expect(within(dialog).getByText("ancient session")).toBeTruthy());
  // Appended, not replaced — the user keeps their place in the list.
  expect(within(dialog).getByText("first session 0")).toBeTruthy();
});

test("a row that arrives twice is listed once (the cursor is timestamp-only)", async () => {
  // `before` is a lastEventAt cursor, so a session written in the same
  // millisecond as the boundary — or one whose activity bumped between
  // requests — can come back in the next page too. A duplicate would break the
  // keyed list, so pages are merged by id.
  const first = fullPage("first", 0);
  const u = setup(first);
  const dialog = await dialogOf(u);
  await waitFor(() => expect(within(dialog).getByText("first session 19")).toBeTruthy());

  u.list.mockResolvedValue([first.at(-1)!, row({ id: "old1", title: "genuinely older" })]);
  await fireEvent.click(within(dialog).getByRole("button", { name: "Load older" }));

  await waitFor(() => expect(within(dialog).getByText("genuinely older")).toBeTruthy());
  expect(within(dialog).getAllByText("first session 19")).toHaveLength(1);
});

test("a short page is the last page: Load older goes away", async () => {
  const u = setup([row({ id: "sa", title: "only session" })]);
  const dialog = await dialogOf(u);

  await waitFor(() => expect(within(dialog).getByText("only session")).toBeTruthy());
  expect(within(dialog).queryByRole("button", { name: "Load older" })).toBeNull();
});

test("Load older disappears once the hub runs out of older sessions", async () => {
  const u = setup(fullPage("first", 0));
  const dialog = await dialogOf(u);
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Load older" })).toBeTruthy());

  u.list.mockResolvedValue([]);
  await fireEvent.click(within(dialog).getByRole("button", { name: "Load older" }));

  await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Load older" })).toBeNull());
  expect(within(dialog).getByText("first session 0")).toBeTruthy(); // nothing was dropped
});

// ─── Selecting ──────────────────────────────────────────────────────────────

test("picking a session hands its id up and closes", async () => {
  const u = setup([row({ id: "sa", title: "the one I want" }), row({ id: "sb", title: "not this" })]);
  const dialog = await dialogOf(u);

  const target = await waitFor(() => {
    const found = within(dialog)
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("the one I want"));
    if (!found) throw new Error("row not rendered yet");
    return found;
  });
  await fireEvent.click(target);

  expect(u.onSelect).toHaveBeenCalledWith("sa");
  expect(u.onClose).toHaveBeenCalledTimes(1);
  // Order matters: the panel attaches, then the dialog gets out of the way.
  expect(u.onSelect.mock.invocationCallOrder[0]).toBeLessThan(
    u.onClose.mock.invocationCallOrder[0],
  );
});

test("the attached session is marked as the current one", async () => {
  const u = setup([row({ id: "sa", title: "on screen" }), row({ id: "sb", title: "not on screen" })], {
    currentSessionId: "sa",
  });
  const dialog = await dialogOf(u);

  const current = await waitFor(() => {
    const found = within(dialog)
      .getAllByRole("button")
      .find((b) => b.getAttribute("aria-current") === "true");
    if (!found) throw new Error("current row not marked yet");
    return found;
  });
  expect(current.textContent).toContain("on screen");
});

// ─── Invariants ─────────────────────────────────────────────────────────────

test("nothing in history ends a session", async () => {
  // Sessions are hub-owned and this surface is read-only: browsing history must
  // never stop an agent process.
  const end = vi.spyOn(api, "endAcpSession");
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  const u = setup(fullPage("first", 0));
  const dialog = await dialogOf(u);
  await waitFor(() => expect(within(dialog).getByText("first session 0")).toBeTruthy());
  await fireEvent.click(within(dialog).getByRole("button", { name: "Load older" }));
  const target = within(dialog)
    .getAllByRole("button")
    .find((b) => b.textContent?.includes("first session 0"))!;
  await fireEvent.click(target);

  expect(end).not.toHaveBeenCalled();
  expect(fetchSpy.mock.calls).toEqual([]);
});

test("the history dialog adds no live region", async () => {
  // The chat header owns the ONE status region in the panel; a second one here
  // would announce every session flip twice.
  const u = setup([row({ id: "sa", title: "a session" })]);
  const dialog = await dialogOf(u);
  await waitFor(() => expect(within(dialog).getByText("a session")).toBeTruthy());

  expect(within(dialog).queryAllByRole("status")).toHaveLength(0);
  expect(within(dialog).queryAllByRole("alert")).toHaveLength(0);
});

test("closing the dialog reports it up (Escape, backdrop, close button)", async () => {
  const u = setup([row({ id: "sa", title: "a session" })]);
  const dialog = await dialogOf(u);

  await fireEvent.keyDown(dialog, { key: "Escape" });

  await waitFor(() => expect(u.onClose).toHaveBeenCalled());
  expect(u.onSelect).not.toHaveBeenCalled();
});
