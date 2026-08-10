import { test, expect, vi } from "vitest";
import { render, waitFor, fireEvent, within } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import type { AcpSessionRow } from "$lib/api/acp";

// bits-ui's Select opens on `pointerdown` and picks an item on `pointerup`,
// touching `hasPointerCapture`/`releasePointerCapture` on the way — jsdom has
// none of those (same polyfill as UserFilters.svelte.test.ts, scoped here).
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
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};

import ChatHeader from "./ChatHeader.svelte";

const row: AcpSessionRow = {
  id: "ses_1",
  stationId: "st_1",
  userId: "u_1",
  mode: "ask",
  status: "idle",
  endedReason: null,
  createdAt: "2026-08-09T10:00:00.000Z",
  lastEventAt: "2026-08-09T10:00:00.000Z",
};

/** ISO timestamp `minutes` ago — keeps relative labels deterministic. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function setup(props: Partial<ComponentProps<typeof ChatHeader>> = {}) {
  const onModeChange = vi.fn();
  const onEnd = vi.fn();
  const onNew = vi.fn();
  const onSelectSession = vi.fn();
  const utils = render(ChatHeader, {
    props: {
      session: row,
      sessions: [row],
      selectedId: row.id,
      status: "idle",
      connection: "connected",
      mode: "ask",
      onModeChange,
      onEnd,
      onNew,
      onSelectSession,
      ...props,
    },
  });
  return { ...utils, onModeChange, onEnd, onNew, onSelectSession };
}

test("mode chips call onModeChange and mark the active mode pressed", async () => {
  const { getByRole, onModeChange } = setup({ session: null, status: "starting" });

  const ask = getByRole("button", { name: "Ask" });
  const acceptEdits = getByRole("button", { name: "Accept edits" });
  const fullAuto = getByRole("button", { name: "Full auto" });

  expect(ask.getAttribute("aria-pressed")).toBe("true");
  expect(acceptEdits.getAttribute("aria-pressed")).toBe("false");

  await fireEvent.click(acceptEdits);
  expect(onModeChange).toHaveBeenCalledWith("accept-edits");
  await fireEvent.click(fullAuto);
  expect(onModeChange).toHaveBeenCalledWith("full-auto");
});

test("status dot + label live in a polite status region", () => {
  const { getByRole } = setup({ status: "working" });

  const region = getByRole("status");
  expect(region.getAttribute("aria-live")).toBe("polite");
  expect(region.textContent).toContain("Working…");
});

test("reconnecting connection overrides the status label", () => {
  const { getByRole } = setup({ status: "working", connection: "reconnecting" });

  const region = getByRole("status");
  expect(region.textContent).toContain("Reconnecting…");
  expect(region.textContent).not.toContain("Working…");
});

test("connecting (replay in flight) overrides the status label", () => {
  // The composer refuses sends until the replay lands, so the header has to say
  // why rather than showing a stale session status.
  const { getByRole } = setup({ status: "working", connection: "connecting" });

  const region = getByRole("status");
  expect(region.textContent).toContain("Connecting…");
  expect(region.textContent).not.toContain("Working…");
});

test("disconnected connection overrides the status label", () => {
  const { getByRole } = setup({ connection: "disconnected" });
  expect(getByRole("status").textContent).toContain("Disconnected");
});

test("End session is gated behind the confirm dialog", async () => {
  const { getByRole, onEnd } = setup();

  await fireEvent.click(getByRole("button", { name: "End session" }));

  const dialog = await waitFor(() => getByRole("dialog"));
  expect(within(dialog).getByText("End this session?")).toBeTruthy();
  expect(
    within(dialog).getByText("The agent process stops and the transcript is kept."),
  ).toBeTruthy();
  expect(onEnd).not.toHaveBeenCalled();

  await fireEvent.click(within(dialog).getByRole("button", { name: "End session" }));
  await waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
});

test("cancelling the confirm dialog does not end the session", async () => {
  const { getByRole, queryByRole, onEnd } = setup();

  await fireEvent.click(getByRole("button", { name: "End session" }));
  const dialog = await waitFor(() => getByRole("dialog"));

  await fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(queryByRole("dialog")).toBeNull());
  expect(onEnd).not.toHaveBeenCalled();
});

test("ended session offers New session and no End session", async () => {
  const { getByRole, queryByRole, onNew } = setup({
    session: { ...row, status: "ended" },
    status: "ended",
  });

  expect(queryByRole("button", { name: "End session" })).toBeNull();

  await fireEvent.click(getByRole("button", { name: "New session" }));
  expect(onNew).toHaveBeenCalledTimes(1);
});

test("a live session offers New session alongside End session", async () => {
  // A station can host several sessions at once, so starting another one is not
  // something to wait for the current one to end.
  const { getByRole, onNew } = setup();

  await fireEvent.click(getByRole("button", { name: "New session" }));

  expect(onNew).toHaveBeenCalledTimes(1);
  expect(getByRole("button", { name: "End session" })).toBeTruthy();
});

test("New session is disabled while a create is in flight", () => {
  const { getByRole } = setup({ creating: true });
  expect((getByRole("button", { name: "New session" }) as HTMLButtonElement).disabled).toBe(true);
});

// ─── Session switcher ───────────────────────────────────────────────────────

const sessionA: AcpSessionRow = {
  ...row,
  id: "ses_a",
  createdAt: "2026-08-09T10:00:00.000Z",
  lastEventAt: minutesAgo(90),
};
const sessionB: AcpSessionRow = {
  ...row,
  id: "ses_b",
  status: "working",
  createdAt: "2026-08-09T11:00:00.000Z",
  lastEventAt: minutesAgo(5),
};

test("with a single session no switcher is rendered", () => {
  // Deliberate: one session means there is nothing to switch to, and an inert
  // control next to the status would just be noise. "New session" is the way to
  // get a second one, and the switcher appears the moment there is one.
  const { queryByRole, getByRole } = setup({ sessions: [row] });

  expect(queryByRole("button", { name: /^Switch session/ })).toBeNull();
  // …and the rest of the header is unchanged.
  expect(getByRole("status").textContent).toContain("Idle");
});

test("the switcher lists every session with its status and last activity", async () => {
  // Newest-activity-first is the hub's SQL order; the header renders it as given.
  const { getByRole, getAllByRole, onSelectSession } = setup({
    sessions: [sessionB, sessionA],
    session: sessionB,
    selectedId: sessionB.id,
    status: "working",
  });

  // The trigger says what it switches, then which session is on screen.
  const trigger = getByRole("button", {
    name: /^Switch session — currently Session 2 · working · 5m ago$/,
  });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });

  const options = await waitFor(() => {
    const found = getAllByRole("option");
    if (found.length < 2) throw new Error("options not rendered yet");
    return found;
  });
  const current = getByRole("option", { name: /^Session 2 · working · 5m ago$/ });
  const other = getByRole("option", { name: /^Session 1 · idle · 1h ago$/ });
  expect(options).toHaveLength(2);
  expect(options[0]).toBe(current); // server order preserved, not re-sorted
  expect(options[1]).toBe(other);

  await fireEvent.pointerUp(other, { pointerId: 1, button: 0, pointerType: "mouse" });
  await waitFor(() => expect(onSelectSession).toHaveBeenCalledWith("ses_a"));
});

test("picking the session already attached is not re-selected", async () => {
  const { getByRole, onSelectSession } = setup({
    sessions: [sessionB, sessionA],
    session: sessionB,
    selectedId: sessionB.id,
    status: "working",
  });

  const trigger = getByRole("button", { name: /currently Session 2/ });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });
  const current = await waitFor(() => getByRole("option", { name: /^Session 2/ }));
  await fireEvent.pointerUp(current, { pointerId: 1, button: 0, pointerType: "mouse" });

  // bits-ui re-fires onValueChange for the same value; a switch back to the
  // session we are already on must not tear its socket down.
  await waitFor(() => expect(getByRole("button", { name: /currently Session 2/ })).toBeTruthy());
  expect(onSelectSession).not.toHaveBeenCalled();
});

test("the switcher adds no second live region", () => {
  const { getAllByRole } = setup({
    sessions: [sessionB, sessionA],
    session: sessionB,
    selectedId: sessionB.id,
    status: "working",
  });

  // The status line is the ONE live region in the panel — a second one here
  // would announce every session flip twice.
  expect(getAllByRole("status")).toHaveLength(1);
});

test("an ended session is still listed, and reads as ended", async () => {
  const ended: AcpSessionRow = { ...sessionA, status: "ended", lastEventAt: minutesAgo(120) };
  const { getByRole } = setup({
    sessions: [sessionB, ended],
    session: sessionB,
    selectedId: sessionB.id,
    status: "working",
  });

  const trigger = getByRole("button", { name: /currently Session 2/ });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });

  const option = await waitFor(() => getByRole("option", { name: /^Session 1 · ended · 2h ago$/ }));
  expect(option).toBeTruthy();
});
