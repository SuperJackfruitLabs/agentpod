import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/client";
// Static import ensures the module is compiled during file collection.
import PosturePanel from "./PosturePanel.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const CLEAN: api.PostureReportResult = {
  hostname: "molt-bot",
  stations: 15,
  findings: [
    {
      check: "creds.world-readable",
      status: "pass",
      severity: "info",
      harness: "hermes",
      title: "Credential file is not readable by others",
      detail: "mode 0600",
    },
  ],
  grade: "A",
};

const BAD: api.PostureReportResult = {
  hostname: "molt-bot",
  stations: 15,
  findings: [
    {
      check: "creds.world-readable",
      status: "fail",
      severity: "critical",
      harness: "hermes",
      station: "hermes:analyst-echo",
      title: "Credentials readable by other users",
      detail: "mode 0644 and reachable",
      path: "/root/.hermes/profiles/analyst-echo/auth.json",
      remedy: "chmod 600 /root/.hermes/profiles/analyst-echo/auth.json",
    },
    {
      check: "listen.public",
      status: "unknown",
      severity: "info",
      title: "Could not check listeners",
      detail: "lsof not found",
    },
    {
      check: "creds.world-readable",
      status: "pass",
      severity: "info",
      harness: "codex",
      title: "Credential file is not readable by others",
      detail: "mode 0600",
    },
  ],
  grade: "F",
};

test("scanning shows the grade", async () => {
  vi.spyOn(api, "nodePosture").mockResolvedValue(CLEAN);
  const { getByRole, getByText } = render(PosturePanel, { props: { nodeId: "node_1" } });
  fireEvent.click(getByRole("button", { name: /scan/i }));
  await waitFor(() => expect(getByText("A")).toBeTruthy());
});

test("failures are shown with their remedy", async () => {
  // The person reading this wants to know what to type, not to go looking.
  vi.spyOn(api, "nodePosture").mockResolvedValue(BAD);
  const { getByRole, getByText, container } = render(PosturePanel, {
    props: { nodeId: "node_1" },
  });
  fireEvent.click(getByRole("button", { name: /scan/i }));

  await waitFor(() => expect(getByText(/Credentials readable by other users/)).toBeTruthy());
  expect(container.textContent).toMatch(/chmod 600/);
});

test("unknown findings are shown separately from passes", async () => {
  // A check that could not run is not a pass. Folding it into passes is how a
  // scanner quietly stops being trustworthy.
  vi.spyOn(api, "nodePosture").mockResolvedValue(BAD);
  const { getByRole, container } = render(PosturePanel, { props: { nodeId: "node_1" } });
  fireEvent.click(getByRole("button", { name: /scan/i }));

  await waitFor(() => expect(container.textContent).toMatch(/lsof not found/));
});

test("a failing finding names the station it belongs to", async () => {
  vi.spyOn(api, "nodePosture").mockResolvedValue(BAD);
  const { getByRole, container } = render(PosturePanel, { props: { nodeId: "node_1" } });
  fireEvent.click(getByRole("button", { name: /scan/i }));
  await waitFor(() => expect(container.textContent).toMatch(/hermes:analyst-echo/));
});

test("a clean machine says so rather than showing nothing", async () => {
  vi.spyOn(api, "nodePosture").mockResolvedValue(CLEAN);
  const { getByRole, container } = render(PosturePanel, { props: { nodeId: "node_1" } });
  fireEvent.click(getByRole("button", { name: /scan/i }));
  await waitFor(() => expect(container.textContent).toMatch(/nothing exposed/i));
});

test("a failed scan shows the error", async () => {
  vi.spyOn(api, "nodePosture").mockRejectedValue(new Error("node offline"));
  const { getByRole, container } = render(PosturePanel, { props: { nodeId: "node_1" } });
  fireEvent.click(getByRole("button", { name: /scan/i }));
  await waitFor(() => expect(container.textContent).toMatch(/node offline/));
});
