import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import PostureBanner from "./PostureBanner.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

const REPORT: api.PostureReportResult = {
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
      detail: "mode 0644",
      remedy: "chmod 600 /root/.hermes/profiles/analyst-echo/auth.json",
    },
    {
      check: "creds.world-readable",
      status: "fail",
      severity: "critical",
      harness: "hermes",
      station: "hermes:coder-kai",
      title: "Credentials readable by other users",
      detail: "mode 0644",
    },
    {
      // Harness-level, no station — belongs on the node page, not here.
      check: "listen.public",
      status: "fail",
      severity: "critical",
      harness: "hermes",
      title: "Agent is listening on every network interface",
      detail: "bound to 0.0.0.0",
    },
  ],
  grade: "F",
};

test("shows a warning when a finding names this station", async () => {
  vi.spyOn(api, "nodePosture").mockResolvedValue(REPORT);
  const { container } = render(PostureBanner, {
    props: { nodeId: "node_1", stationKey: "hermes:analyst-echo" },
  });
  await waitFor(() => expect(container.textContent).toMatch(/readable by other users/i));
  expect(container.textContent).toMatch(/chmod 600/);
});

test("shows only this station's finding, not its neighbour's", async () => {
  vi.spyOn(api, "nodePosture").mockResolvedValue(REPORT);
  const { container } = render(PostureBanner, {
    props: { nodeId: "node_1", stationKey: "hermes:analyst-echo" },
  });
  await waitFor(() => expect(container.textContent).toMatch(/readable by other users/i));
  expect(container.textContent).not.toMatch(/coder-kai/);
});

test("host-level findings are not repeated here", async () => {
  // This Mac has twenty-odd claude-code stations sharing one credential file.
  // A banner that appears on all of them is a banner nobody reads.
  vi.spyOn(api, "nodePosture").mockResolvedValue(REPORT);
  const { container } = render(PostureBanner, {
    props: { nodeId: "node_1", stationKey: "hermes:analyst-echo" },
  });
  await waitFor(() => expect(container.textContent).toMatch(/readable by other users/i));
  expect(container.textContent).not.toMatch(/every network interface/);
});

test("stays silent for a station with no findings", async () => {
  vi.spyOn(api, "nodePosture").mockResolvedValue(REPORT);
  const { container } = render(PostureBanner, {
    props: { nodeId: "node_1", stationKey: "hermes:writer-quill" },
  });
  await waitFor(() => expect(api.nodePosture).toHaveBeenCalled());
  expect(container.textContent?.trim()).toBe("");
});

test("stays silent when the scan fails", async () => {
  // A passive banner on someone else's page; a failed background scan must not
  // put an error where they did not ask for one.
  vi.spyOn(api, "nodePosture").mockRejectedValue(new Error("node offline"));
  const { container } = render(PostureBanner, {
    props: { nodeId: "node_1", stationKey: "hermes:analyst-echo" },
  });
  await waitFor(() => expect(api.nodePosture).toHaveBeenCalled());
  expect(container.textContent?.trim()).toBe("");
});
