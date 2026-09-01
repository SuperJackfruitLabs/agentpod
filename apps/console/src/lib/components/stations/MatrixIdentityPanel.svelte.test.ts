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

test("a station whose two columns agree on the OLD address is still offered the move", async () => {
  // The defect, from the console's side. `bridgeMatrixId` is not a prop any
  // more, so the only way this panel can call a station converged is if the
  // HUB says so — and for this station the hub says `retired-identity`,
  // because the address the agent's handle implies is not the one it answers
  // as. The old panel, handed `{matrixId: OLD, bridgeMatrixId: OLD}`, showed
  // "identity has switched" and no control at all.
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

test("a click's waiting state is not overwritten by a slower answer about how things stood before it", async () => {
  // Reviewer's finding (fix-wave-2, Ruling 17): this test used to resolve the
  // mount's `moveState` fetch with `status: "retired-identity"` — a status
  // the guarded callback never acts on regardless of the `phase !== "idle"`
  // guard it claimed to pin, since the callback only writes anything when
  // `s.status === "waiting"`. The reviewer removed the guard and all 13
  // tests, including this one, still passed.
  //
  // The guard's actual job: the operator clicks while the mount's own
  // `moveState` request is still in flight. That request describes how
  // things stood BEFORE the click — including a `since` from whatever
  // authorization existed then — and a `status: "waiting"` reply arriving
  // mid-click must not be adopted while the click's own request (`authorize`)
  // is still outstanding. Both promises are held open here so the race is
  // real: `moveState` settles WHILE `authorize` is still pending.
  //
  // The click has to be reachable before the hub has answered anything, which
  // is why the panel renders the control off the FIRST answer and keeps it
  // through the second: this test resolves the mount request only after the
  // button has been pressed, so the first answer here is a rendered one.
  const STALE_SINCE = "2020-01-01T00:00:00Z";
  let settleMoveState: (s: unknown) => void = () => {};
  const moveState = vi.fn().mockReturnValue(
    new Promise((resolve) => {
      settleMoveState = resolve;
    })
  );
  let settleAuthorize: (r: { expiresAt: string }) => void = () => {};
  const authorize = vi.fn().mockReturnValue(
    new Promise((resolve) => {
      settleAuthorize = resolve;
    })
  );
  const { rerender } = render(MatrixIdentityPanel, { station: RETIRED, authorize, moveState });

  // Nothing is offered until the hub has answered — the panel no longer
  // guesses from a column.
  expect(screen.queryByRole("button", { name: /move to its own identity/i })).toBeNull();
  settleMoveState({ status: "retired-identity", runningAs: OLD, willBecome: NEW });
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: /move to its own identity/i })).toBeTruthy()
  );

  await fireEvent.click(screen.getByRole("button", { name: /move to its own identity/i }));
  expect(screen.getByRole("button", { name: /authorizing/i })).toBeTruthy();

  // A SECOND answer to the same question — a stale `waiting`, from before this
  // click — lands while `authorize` is still outstanding.
  let settleAgain: (s: unknown) => void = () => {};
  moveState.mockReturnValueOnce(
    new Promise((resolve) => {
      settleAgain = resolve;
    })
  );
  await rerender({ station: { id: "station_2", matrixId: OLD }, authorize, moveState });
  settleAgain({ status: "waiting", runningAs: OLD, willBecome: NEW, since: STALE_SINCE });
  await tick();

  // Still authorizing: the in-flight click outranks a reply about the past.
  // Without the guard, `phase` would flip to `"waiting"` here — before the
  // click's own request has even resolved — and this stale `since` would be
  // what the operator sees.
  expect(screen.getByRole("button", { name: /authorizing/i })).toBeTruthy();
  expect(screen.queryByText(/waiting for the node/i)).toBeNull();

  settleAuthorize({ expiresAt: "2026-09-01T12:00:00Z" });
  await vi.waitFor(() => expect(screen.getByText(/waiting for the node/i)).toBeTruthy());
  // The click's own answer is what's shown, not the stale one that arrived
  // mid-flight.
  expect(screen.queryByText(new Date(STALE_SINCE).toLocaleString())).toBeNull();
});
