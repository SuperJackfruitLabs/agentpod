import { test, expect, vi } from "vitest";
import { render, waitFor, fireEvent, within } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import type { AcpSessionRow } from "$lib/api/acp";
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

function setup(props: Partial<ComponentProps<typeof ChatHeader>> = {}) {
  const onModeChange = vi.fn();
  const onEnd = vi.fn();
  const onNew = vi.fn();
  const utils = render(ChatHeader, {
    props: {
      session: row,
      status: "idle",
      connection: "connected",
      mode: "ask",
      onModeChange,
      onEnd,
      onNew,
      ...props,
    },
  });
  return { ...utils, onModeChange, onEnd, onNew };
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

test("ended session shows New session instead of End session", async () => {
  const { getByRole, queryByRole, onNew } = setup({
    session: { ...row, status: "ended" },
    status: "ended",
  });

  expect(queryByRole("button", { name: "End session" })).toBeNull();

  await fireEvent.click(getByRole("button", { name: "New session" }));
  expect(onNew).toHaveBeenCalledTimes(1);
});
