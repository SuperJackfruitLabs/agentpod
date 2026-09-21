import { test, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import StationSetup from "./StationSetup.svelte";
import * as setup from "$lib/api/station-setup";
import * as client from "$lib/api/client";
vi.mock("$lib/api/station-setup", () => ({
  getSetupOptions: vi.fn(),
  completeStationSetup: vi.fn(),
  retryStationMatrix: vi.fn(),
}));
vi.mock("$lib/api/client", () => ({ adoptStations: vi.fn() }));
const target = {
  id: "station-1",
  nodeId: "node-1",
  stationKey: "codex:abcdef",
  displayName: "SuperJackfruit",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setup.getSetupOptions).mockResolvedValue({
    agents: [],
    matrixDomain: "matrix.example",
  });
  vi.mocked(setup.completeStationSetup).mockResolvedValue({
    principalId: "prn_00000000000000000001",
    matrix: {
      status: "provisioned",
      address: "@agent_superjackfruit:matrix.example",
      roomId: "!room",
      mode: "bridge",
    },
  });
});
test("previews identity and Matrix address; grants require explicit selection", async () => {
  const { getByLabelText, getByRole, findByText } = render(StationSetup, {
    props: { open: true, target, onComplete: vi.fn() },
  });
  expect(await findByText("@agent_superjackfruit:matrix.example")).toBeTruthy();
  expect((getByLabelText("Agent handle") as HTMLInputElement).value).toBe(
    "superjackfruit",
  );
  await fireEvent.click(getByRole("button", { name: "Complete setup" }));
  await waitFor(() =>
    expect(setup.completeStationSetup).toHaveBeenCalledWith(
      "station-1",
      expect.objectContaining({
        agent: {
          kind: "new",
          handle: "superjackfruit",
          displayName: "SuperJackfruit",
        },
        dispatch: "none",
      }),
    ),
  );
});
test("registration happens only after review; failed setup retries the same request without re-adopting", async () => {
  vi.mocked(client.adoptStations).mockResolvedValue([
    { ...target, principalId: null },
  ] as any);
  vi.mocked(setup.completeStationSetup).mockRejectedValueOnce(
    new Error("Connection lost"),
  );
  const { getByRole, findByText } = render(StationSetup, {
    props: {
      open: true,
      target: { ...target, id: undefined },
      onComplete: vi.fn(),
    },
  });
  await findByText("@agent_superjackfruit:matrix.example");
  expect(client.adoptStations).not.toHaveBeenCalled();
  await fireEvent.click(getByRole("button", { name: "Complete setup" }));
  await findByText("Connection lost");
  await fireEvent.click(getByRole("button", { name: "Complete setup" }));
  await waitFor(() =>
    expect(setup.completeStationSetup).toHaveBeenCalledTimes(2),
  );
  expect(client.adoptStations).toHaveBeenCalledTimes(1);
  expect(vi.mocked(setup.completeStationSetup).mock.calls[0]).toEqual(
    vi.mocked(setup.completeStationSetup).mock.calls[1],
  );
});
test("Matrix failure exposes retry without creating or granting again", async () => {
  vi.mocked(setup.completeStationSetup).mockResolvedValueOnce({
    principalId: "prn_00000000000000000001",
    matrix: {
      status: "failed",
      error: "Offline",
      address: null,
      roomId: null,
      mode: "bridge",
    },
  });
  vi.mocked(setup.retryStationMatrix).mockResolvedValue({
    principalId: "prn_00000000000000000001",
    matrix: {
      status: "provisioned",
      address: "@agent_superjackfruit:matrix.example",
      roomId: "!room",
      mode: "bridge",
    },
  });
  const { getByRole, findByText } = render(StationSetup, {
    props: { open: true, target, onComplete: vi.fn() },
  });
  await findByText("@agent_superjackfruit:matrix.example");
  await fireEvent.click(getByRole("button", { name: "Complete setup" }));
  await findByText("Agent ready; Matrix setup pending");
  await fireEvent.click(getByRole("button", { name: "Retry Matrix setup" }));
  await findByText("Matrix room ready");
  expect(setup.completeStationSetup).toHaveBeenCalledTimes(1);
  expect(setup.retryStationMatrix).toHaveBeenCalledWith(
    "station-1",
    "prn_00000000000000000001",
  );
});

test("cancel does not register a workspace or create an identity", async () => {
  const { getByRole, findByText } = render(StationSetup, {
    props: {
      open: true,
      target: { ...target, id: undefined },
      onComplete: vi.fn(),
    },
  });
  await findByText("@agent_superjackfruit:matrix.example");
  await fireEvent.click(getByRole("button", { name: "Cancel" }));
  expect(client.adoptStations).not.toHaveBeenCalled();
  expect(setup.completeStationSetup).not.toHaveBeenCalled();
});
test("register-only is explicit and does not create identities or grants", async () => {
  vi.mocked(client.adoptStations).mockResolvedValue([
    { ...target, stationKey: target.stationKey },
  ] as any);
  const onComplete = vi.fn();
  const { getByRole, getByLabelText, findByText } = render(StationSetup, {
    props: { open: true, target: { ...target, id: undefined }, onComplete },
  });
  await findByText("@agent_superjackfruit:matrix.example");
  await fireEvent.change(getByLabelText("Agent identity"), {
    target: { value: "register" },
  });
  await fireEvent.click(getByRole("button", { name: "Register workspace" }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
  expect(setup.completeStationSetup).not.toHaveBeenCalled();
});
test("parent refresh after completion does not reset the Matrix result", async () => {
  const view = render(StationSetup, {
    props: { open: true, target, onComplete: vi.fn() },
  });
  await view.findByText("@agent_superjackfruit:matrix.example");
  await fireEvent.click(view.getByRole("button", { name: "Complete setup" }));
  await view.findByText("Matrix room ready");
  await view.rerender({
    open: true,
    target: { ...target },
    onComplete: vi.fn(),
  });
  expect(view.getByText("Matrix room ready")).toBeTruthy();
});
