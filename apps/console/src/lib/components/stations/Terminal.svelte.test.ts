/**
 * Terminal.svelte's one job here: every dial hands the socket a token from `socketToken()` — a
 * fresh one under the org plane (P3 Task 15, Review Focus 5), null (the cookie) in legacy mode.
 * xterm is stubbed; the socket wrapper's own behaviour is covered in api/terminal.test.ts.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/svelte";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    onData() {}
    onSelectionChange() {}
    getSelection() { return ""; }
    write() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("$lib/api/terminal", () => ({ createTerminalClient: vi.fn() }));

import { createTerminalClient } from "$lib/api/terminal";
import * as client from "$lib/api/client";
import Terminal from "./Terminal.svelte";

const fakeClient = () => ({ onData: vi.fn(), onClose: vi.fn(), send: vi.fn(), resize: vi.fn(), close: vi.fn() });

beforeEach(() => {
  vi.mocked(createTerminalClient).mockReset().mockImplementation(fakeClient as never);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("under the plane the terminal dials with the socket token", async () => {
  const pending = Promise.resolve("at1");
  vi.spyOn(client, "socketToken").mockReturnValue(pending);
  render(Terminal, { props: { stationId: "st_1" } });
  await waitFor(() => expect(createTerminalClient).toHaveBeenCalled(), { timeout: 3000 });
  expect(createTerminalClient).toHaveBeenCalledWith("st_1", pending);
});

test("legacy mode: the terminal dials with no token", async () => {
  vi.spyOn(client, "socketToken").mockReturnValue(null);
  render(Terminal, { props: { stationId: "st_1" } });
  await waitFor(() => expect(createTerminalClient).toHaveBeenCalled(), { timeout: 3000 });
  expect(createTerminalClient).toHaveBeenCalledWith("st_1", null);
});
