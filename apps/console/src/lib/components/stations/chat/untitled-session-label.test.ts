/**
 * untitled-session-label.test.ts
 *
 * Regression for the 4d live-verification blemish: the chat header's
 * switcher rendered "Session N" for an untitled row while the history
 * dialog rendered "Untitled session" for the SAME row — two different words
 * for the same absence of a title, in two surfaces a user is likely to
 * compare side by side.
 *
 * Both surfaces must render the identical fallback text, via the ONE shared
 * helper in session-status.ts (`untitledSessionLabel`).
 */

import { test, expect, vi } from "vitest";
import { render, waitFor, within, fireEvent } from "@testing-library/svelte";
import type { AcpSessionRow } from "$lib/api/acp";
import * as api from "$lib/api/acp";

import ChatHeader from "./ChatHeader.svelte";
import SessionHistory from "./SessionHistory.svelte";
import { sessionOrdinals, untitledSessionLabel } from "./session-status";

// bits-ui's Select opens on `pointerdown` and touches capture APIs jsdom
// lacks — same polyfill as ChatHeader.svelte.test.ts.
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

const titled: AcpSessionRow = {
  id: "ses_titled",
  stationId: "st_1",
  userId: "u_1",
  mode: "ask",
  status: "idle",
  endedReason: null,
  createdAt: "2026-08-09T10:00:00.000Z",
  lastEventAt: "2026-08-09T10:00:00.000Z",
  title: "Fix the flaky test",
  lastSeq: 4,
};

const untitled: AcpSessionRow = {
  id: "ses_untitled",
  stationId: "st_1",
  userId: "u_1",
  mode: "ask",
  status: "working",
  endedReason: null,
  createdAt: "2026-08-09T11:00:00.000Z",
  lastEventAt: "2026-08-09T11:05:00.000Z",
  title: null,
  lastSeq: 2,
};

const sessions = [untitled, titled]; // hub's newest-activity-first order

test("untitledSessionLabel / sessionOrdinals: numbers by creation order, ties break on id", () => {
  const ordinals = sessionOrdinals(sessions);
  // Sorted by createdAt: titled (10:00) is older than untitled (11:00).
  expect(ordinals.get(titled.id)).toBe(1);
  expect(ordinals.get(untitled.id)).toBe(2);
  expect(untitledSessionLabel(sessions, untitled.id)).toBe("Session 2");
});

test("the chat header's switcher and the history dialog render the SAME fallback for the same untitled row", async () => {
  // ── Chat header ──
  const header = render(ChatHeader, {
    props: {
      session: untitled,
      sessions,
      selectedId: untitled.id,
      status: "working",
      connection: "connected",
      mode: "ask",
      onModeChange: vi.fn(),
      onEnd: vi.fn(),
      onNew: vi.fn(),
      onSelectSession: vi.fn(),
      onOpenHistory: vi.fn(),
    },
  });
  await fireEvent.pointerDown(
    header.getByRole("button", { name: /^Switch session/ }),
    { pointerId: 1, button: 0, pointerType: "mouse" },
  );
  const headerOption = await waitFor(() =>
    header.getByRole("option", { name: /^Session 2 ·/ }),
  );
  expect(headerOption).toBeTruthy();
  header.unmount();

  // ── History dialog ──
  vi.spyOn(api, "listAcpSessions").mockResolvedValue(sessions);
  const history = render(SessionHistory, {
    props: {
      stationId: "st_1",
      currentSessionId: null,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    },
  });
  const dialog = await waitFor(() => history.getByRole("dialog"));

  // Same word, same number, for the same row — not "Untitled session".
  expect(await waitFor(() => within(dialog).getByText("Session 2"))).toBeTruthy();
  expect(within(dialog).queryByText("Untitled session")).toBeNull();
  history.unmount();
});
