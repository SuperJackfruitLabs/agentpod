/**
 * MatrixIdentityPanel.svelte.test.ts
 *
 * The §1 invariant (`db/schema/stations.ts`, design
 * `docs/superpowers/specs/2026-09-01-uniform-matrix-identity-design.md` §6)
 * asks one question — **is this agent on its principal's address?** — and only
 * the agent's handle answers it.
 *
 * These tests used to be written the other way round, against two columns:
 *
 *   matrixId === null              → bridge mode, nothing to do
 *   matrixId === bridgeMatrixId    → converged
 *   matrixId !== bridgeMatrixId    → running under a retired identity
 *
 * and every fixture set `bridgeMatrixId` to the handle-derived address, which
 * is what the design assumed and what production does not do. `provision.ts`
 * writes `bridge_matrix_id` from `stationSpeaker`, and for a harness station
 * that is the harness's OWN mxid — so on the fleet all 14 harness stations
 * have both columns holding the same retired, station-derived address, this
 * panel called every one of them converged, and the move it exists to offer
 * could never be started by anyone. The tests passed throughout, because the
 * fixtures were the assumption rather than the fleet.
 *
 * So the states now come from the hub (`matrix/move-state`), which is the only
 * place that can build the address a handle implies. `matrixId === null` is
 * still answered here, because that half of the invariant really is a column.
 *
 * The move itself is fire-and-forget on the hub's side (Task 3): authorizing
 * only signals the node, and convergence is observed later. So the control
 * must survive a successful click — a station stuck waiting is exactly the
 * operator who most needs to be able to press it again.
 */

import { test, expect, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/svelte";
import { afterEach } from "vitest";
import { tick } from "svelte";
import MatrixIdentityPanel from "./MatrixIdentityPanel.svelte";

afterEach(cleanup);

const OLD = "@agent_guild_hermes-writer-quill:matrix.example.org";
const NEW = "@agent_writer-quill:matrix.example.org";

/**
 * A station exactly as the fleet has it: answering as the station-derived
 * address, with `bridge_matrix_id` holding that SAME address — which is why
 * nothing in this component may be handed that column any more. All the panel
 * gets is the station's id and what its harness reports.
 */
const RETIRED = { id: "station_1", matrixId: OLD };

/** The hub's answer for such a station: a move is available, and here is its target. */
const saysRetired = () =>
  vi.fn().mockResolvedValue({ status: "retired-identity", runningAs: OLD, willBecome: NEW });

test("a station the hub says is on a retired identity says so, naming both addresses", async () => {
  const moveState = saysRetired();
  render(MatrixIdentityPanel, { station: RETIRED, moveState });

  expect(await screen.findByText(/retired identity/i)).toBeTruthy();
  expect(screen.getByText(OLD)).toBeTruthy();
  // The address it is moving to comes from the hub, which derived it from the
  // agent's handle. The browser could not have built this string.
  expect(screen.getByText(NEW)).toBeTruthy();
  expect(moveState).toHaveBeenCalledWith(RETIRED.id);
});

test("only the hub can call a station converged — the panel never decides that from a row", async () => {
  // The defect, from the console's side. `bridgeMatrixId` is not a prop any
  // more, so the only way this panel can call a station converged is if the
  // HUB says so — and for this station the hub says `retired-identity`,
  // because the address the agent's handle implies is not the one it answers
  // as. The old panel, handed the fleet's real row
  // (`{matrixId: OLD, bridgeMatrixId: OLD}`), showed "identity has switched"
  // and no control at all.
  render(MatrixIdentityPanel, { station: RETIRED, moveState: saysRetired() });

  expect(await screen.findByRole("button", { name: /move to its own identity/i })).toBeTruthy();
  expect(screen.queryByText(/identity has switched/i)).toBeNull();
});

test("the move control calls authorize-move, then shows waiting for the node", async () => {
  const authorize = vi.fn().mockResolvedValue({ expiresAt: "2026-09-01T12:00:00Z" });
  render(MatrixIdentityPanel, { station: RETIRED, authorize, moveState: saysRetired() });
  await fireEvent.click(await screen.findByRole("button", { name: /move to its own identity/i }));
  expect(authorize).toHaveBeenCalledWith(RETIRED.id);
  expect(screen.getByText(/waiting for the node/i)).toBeTruthy();
});

test("a 403 from the grant gate is shown verbatim", async () => {
  // The hub's own sentence (station-matrix.ts's authorize-move route) names
  // which grant refused. Replacing it with a generic failure is how an
  // operator ends up unable to tell "not permitted" from "broken".
  const authorize = vi
    .fn()
    .mockRejectedValue(
      new Error(
        "Authorizing this station to redeem its own Matrix credential is granting it " +
          "reach, which your grant does not permit for this agent."
      )
    );
  render(MatrixIdentityPanel, { station: RETIRED, authorize, moveState: saysRetired() });
  await fireEvent.click(await screen.findByRole("button", { name: /move to its own identity/i }));
  expect(
    await screen.findByText(/redeem its own matrix credential is granting it reach/i)
  ).toBeTruthy();
});

test("a 409 naming the harness with no profile writer is shown verbatim", async () => {
  // The hub's 409 for this route names the harness, not a generic "conflict" —
  // the same station-matrix.ts route, for a harness the node-agent has no
  // adapter for.
  const authorize = vi
    .fn()
    .mockRejectedValue(
      new Error("codex has no Matrix profile writer yet, so this station cannot move to its own identity.")
    );
  render(MatrixIdentityPanel, { station: RETIRED, authorize, moveState: saysRetired() });
  await fireEvent.click(await screen.findByRole("button", { name: /move to its own identity/i }));
  expect(await screen.findByText(/codex has no matrix profile writer yet/i)).toBeTruthy();
});

test("a converged station shows no control", async () => {
  const moveState = vi.fn().mockResolvedValue({ status: "converged", mxid: NEW });
  render(MatrixIdentityPanel, { station: { id: "station_1", matrixId: NEW }, moveState });
  expect(await screen.findByText(/identity has switched/i)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /move to its own identity/i })).toBeNull();
});

// ─── The states the brief's table names but doesn't spell a test for ──────────

test("a bridge-mode station (matrixId null) renders nothing, and asks nothing", () => {
  // The one state a raw column really does settle: `matrix_id IS NULL` means
  // the appservice speaks for the station. No round trip, no box.
  const moveState = vi.fn();
  const { container } = render(MatrixIdentityPanel, {
    station: { id: "station_1", matrixId: null },
    moveState,
  });
  expect(container.textContent?.trim()).toBe("");
  expect(moveState).not.toHaveBeenCalled();
});

test("a converged station never claims to be healthy", async () => {
  const moveState = vi.fn().mockResolvedValue({ status: "converged", mxid: NEW });
  render(MatrixIdentityPanel, { station: { id: "station_1", matrixId: NEW }, moveState });
  await screen.findByText(/identity has switched/i);
  for (const word of [/healthy/i, /\bok\b/i, /✓/]) {
    expect(screen.queryByText(word)).toBeNull();
  }
});

test("a station with no occupying agent is told so, and offered no move", async () => {
  // No agent means no handle means no address to move to. The hub says so
  // rather than the panel guessing, and a station answering as an mxid no
  // principal owns is a thing an operator must see rather than a blank.
  const moveState = vi.fn().mockResolvedValue({ status: "no-agent", runningAs: OLD });
  render(MatrixIdentityPanel, { station: RETIRED, moveState });

  expect(await screen.findByText(/no agent occupies it/i)).toBeTruthy();
  expect(screen.getByText(OLD)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /move to its own identity/i })).toBeNull();
});

test("the control survives a successful authorize — re-authorizing is the retry", async () => {
  const authorize = vi.fn().mockResolvedValue({ expiresAt: "2026-09-01T12:00:00Z" });
  render(MatrixIdentityPanel, { station: RETIRED, authorize, moveState: saysRetired() });
  await fireEvent.click(await screen.findByRole("button", { name: /move to its own identity/i }));
  // Waiting is not a dead end: the control that just fired is still there.
  expect(screen.getByRole("button", { name: /move to its own identity/i })).toBeTruthy();
  expect(screen.getByRole("button", { name: /move to its own identity/i })).not.toHaveProperty(
    "disabled",
    true
  );
});

// ─── The hub is the source, not this component's memory ───────────────────────

test("a station the hub says is waiting shows waiting on first render, with no click", async () => {
  const moveState = vi.fn().mockResolvedValue({
    status: "waiting",
    runningAs: OLD,
    willBecome: NEW,
    since: "2026-09-01T09:00:00Z",
  });
  render(MatrixIdentityPanel, { station: RETIRED, moveState });

  expect(await screen.findByText(/waiting for the node/i)).toBeTruthy();
  expect(moveState).toHaveBeenCalledWith(RETIRED.id);
  // Ruling 9 intact: the control is still there, because re-authorizing is
  // the retry and a station stuck waiting is the operator who most needs it.
  expect(screen.getByRole("button", { name: /move to its own identity/i })).toBeTruthy();
});

test("a station nobody has asked to move shows the control and no waiting line", async () => {
  const moveState = saysRetired();
  render(MatrixIdentityPanel, { station: RETIRED, moveState });

  expect(await screen.findByRole("button", { name: /move to its own identity/i })).toBeTruthy();
  await vi.waitFor(() => expect(moveState).toHaveBeenCalled());
  expect(screen.queryByText(/waiting for the node/i)).toBeNull();
});

test("a hub that cannot answer says so rather than offering a move it cannot describe", async () => {
  // This used to assert that a failed fetch "costs the waiting line and
  // nothing else", with the control still rendered — which was defensible
  // while three states came off the row. They do not: without the hub's
  // answer this panel does not know whether there is a move to offer, or what
  // address it would end at, and a control built on that guess is the defect
  // this whole change removes. Saying nothing at all would be the other half
  // of the same silence, so it says what it could not find out.
  const moveState = vi.fn().mockRejectedValue(new Error("hub unreachable"));
  render(MatrixIdentityPanel, { station: RETIRED, moveState });

  expect(await screen.findByText(/couldn't ask the hub/i)).toBeTruthy();
  await vi.waitFor(() => expect(moveState).toHaveBeenCalled());
  // Not an alarm — nothing is broken, one question went unanswered.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: /move to its own identity/i })).toBeNull();
});

// ─── One panel, many stations: nothing may follow you from the last one ───────
//
// `[stationId]/+page.svelte` is ONE page reused across stations, so this
// component is not remounted when an operator moves from A to B. Everything it
// learned about A therefore has to be cleared when B arrives, or B is rendered
// with A's answer until its own turns up.

test("a hub failure on one station does not follow you to the next", async () => {
  // `unanswered` used to be write-once-true: one unreachable hub, and every
  // station visited afterwards in the same session claimed the hub could not
  // be asked — with its move hidden behind that claim.
  const moveState = vi
    .fn()
    .mockRejectedValueOnce(new Error("hub unreachable"))
    .mockResolvedValueOnce({ status: "retired-identity", runningAs: OLD, willBecome: NEW });

  const { rerender } = render(MatrixIdentityPanel, { station: RETIRED, moveState });
  expect(await screen.findByText(/couldn't ask the hub/i)).toBeTruthy();

  await rerender({ station: { id: "station_2", matrixId: OLD }, moveState });

  expect(await screen.findByRole("button", { name: /move to its own identity/i })).toBeTruthy();
  expect(screen.queryByText(/couldn't ask the hub/i)).toBeNull();
  expect(moveState).toHaveBeenNthCalledWith(2, "station_2");
});

test("a station is never rendered with the previous station's answer", async () => {
  // The serious half. An operator lands on B, reads A's target address in the
  // sentence, and presses A's move — on B. Nothing may be offered for a
  // station this panel has not yet been told anything about.
  const B_TARGET = "@agent_analyst-echo:matrix.example.org";
  let settleSecond: (s: unknown) => void = () => {};
  const moveState = vi
    .fn()
    .mockResolvedValueOnce({ status: "retired-identity", runningAs: OLD, willBecome: NEW })
    .mockReturnValueOnce(
      new Promise((resolve) => {
        settleSecond = resolve;
      })
    );

  const { rerender } = render(MatrixIdentityPanel, { station: RETIRED, moveState });
  expect(await screen.findByText(NEW)).toBeTruthy();

  await rerender({ station: { id: "station_2", matrixId: OLD }, moveState });

  // The hub has not answered for station_2 yet: no address, no control, and
  // above all not station_1's.
  expect(screen.queryByText(NEW)).toBeNull();
  expect(screen.queryByRole("button", { name: /move to its own identity/i })).toBeNull();

  settleSecond({ status: "retired-identity", runningAs: OLD, willBecome: B_TARGET });
  expect(await screen.findByText(B_TARGET)).toBeTruthy();
});

test("a click on one station does not leave the next one claiming to be waiting", async () => {
  // `phase` is per-station too: authorising A must not make B say it is
  // waiting for a node to redeem an authorisation nobody minted for it.
  const authorize = vi.fn().mockResolvedValue({ expiresAt: "2026-09-01T12:00:00Z" });
  const moveState = vi
    .fn()
    .mockResolvedValue({ status: "retired-identity", runningAs: OLD, willBecome: NEW });

  const { rerender } = render(MatrixIdentityPanel, { station: RETIRED, authorize, moveState });
  await fireEvent.click(await screen.findByRole("button", { name: /move to its own identity/i }));
  expect(screen.getByText(/waiting for the node/i)).toBeTruthy();

  await rerender({ station: { id: "station_2", matrixId: OLD }, authorize, moveState });

  await screen.findByRole("button", { name: /move to its own identity/i });
  expect(screen.queryByText(/waiting for the node/i)).toBeNull();
});

test("an answer about the station you left never lands on the one you are looking at", async () => {
  // What is left of Ruling 17's guard once the control renders only after an
  // answer: a click can no longer overtake this panel's own request for the
  // same station, so the reachable version of "a reply about the past" is a
  // reply about a DIFFERENT station, arriving after the move to this one. The
  // effect's cleanup is what drops it — without that, A's late answer would
  // overwrite the state B's arrival just cleared, which is the same leak by a
  // slower route.
  let settleFirst: (s: unknown) => void = () => {};
  const moveState = vi
    .fn()
    .mockReturnValueOnce(
      new Promise((resolve) => {
        settleFirst = resolve;
      })
    )
    .mockResolvedValueOnce({ status: "converged", mxid: NEW });

  const { rerender } = render(MatrixIdentityPanel, { station: RETIRED, moveState });
  await rerender({ station: { id: "station_2", matrixId: NEW }, moveState });
  expect(await screen.findByText(/identity has switched/i)).toBeTruthy();

  // station_1's answer, arriving late. It must change nothing about station_2.
  settleFirst({ status: "retired-identity", runningAs: OLD, willBecome: NEW });
  await tick();

  expect(screen.getByText(/identity has switched/i)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /move to its own identity/i })).toBeNull();
  expect(screen.queryByText(/retired identity/i)).toBeNull();
});
