/**
 * MatrixIdentityPanel.svelte.test.ts
 *
 * The §1 invariant (`db/schema/stations.ts`, design
 * `docs/superpowers/specs/2026-09-01-uniform-matrix-identity-design.md` §6) has
 * no status column — it's read off two existing ones:
 *
 *   matrixId === null              → bridge mode, nothing to do
 *   matrixId === bridgeMatrixId    → converged (NOT "healthy" — room
 *                                     membership lives in neither column, so
 *                                     this panel only says the identity switched)
 *   matrixId !== bridgeMatrixId    → running under a retired identity, and
 *                                     the one control this panel exists for
 *
 * The move itself is fire-and-forget on the hub's side (Task 3): authorizing
 * only signals the node, and convergence is observed later. So the control
 * must survive a successful click — a station stuck waiting is exactly the
 * operator who most needs to be able to press it again.
 */

import { test, expect, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/svelte";
import { afterEach } from "vitest";
import MatrixIdentityPanel from "./MatrixIdentityPanel.svelte";

afterEach(cleanup);

const OLD = "@agent_guild_hermes-writer-quill:matrix.example.org";
const NEW = "@agent_writer-quill:matrix.example.org";
const RETIRED = { id: "station_1", matrixId: OLD, bridgeMatrixId: NEW };

test("a station on a retired identity says so, naming both addresses", () => {
  render(MatrixIdentityPanel, { station: { matrixId: OLD, bridgeMatrixId: NEW } });
  expect(screen.getByText(/retired identity/i)).toBeTruthy();
  expect(screen.getByText(OLD)).toBeTruthy();
  expect(screen.getByText(NEW)).toBeTruthy();
});

test("the move control calls authorize-move, then shows waiting for the node", async () => {
  const authorize = vi.fn().mockResolvedValue({ expiresAt: "2026-09-01T12:00:00Z" });
  render(MatrixIdentityPanel, { station: RETIRED, authorize });
  await fireEvent.click(screen.getByRole("button", { name: /move to its own identity/i }));
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
  render(MatrixIdentityPanel, { station: RETIRED, authorize });
  await fireEvent.click(screen.getByRole("button", { name: /move to its own identity/i }));
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
  render(MatrixIdentityPanel, { station: RETIRED, authorize });
  await fireEvent.click(screen.getByRole("button", { name: /move to its own identity/i }));
  expect(await screen.findByText(/codex has no matrix profile writer yet/i)).toBeTruthy();
});

test("a converged station shows no control", () => {
  render(MatrixIdentityPanel, { station: { matrixId: NEW, bridgeMatrixId: NEW } });
  expect(screen.queryByRole("button", { name: /move to its own identity/i })).toBeNull();
});

// ─── The two states the brief's table names but doesn't spell a test for ──────

test("a bridge-mode station (matrixId null) renders nothing", () => {
  const { container } = render(MatrixIdentityPanel, {
    station: { matrixId: null, bridgeMatrixId: NEW },
  });
  expect(container.textContent?.trim()).toBe("");
});

test("a converged station never claims to be healthy", () => {
  render(MatrixIdentityPanel, { station: { matrixId: NEW, bridgeMatrixId: NEW } });
  for (const word of [/healthy/i, /\bok\b/i, /✓/]) {
    expect(screen.queryByText(word)).toBeNull();
  }
});

test("the control survives a successful authorize — re-authorizing is the retry", async () => {
  const authorize = vi.fn().mockResolvedValue({ expiresAt: "2026-09-01T12:00:00Z" });
  render(MatrixIdentityPanel, { station: RETIRED, authorize });
  await fireEvent.click(screen.getByRole("button", { name: /move to its own identity/i }));
  // Waiting is not a dead end: the control that just fired is still there.
  expect(screen.getByRole("button", { name: /move to its own identity/i })).toBeTruthy();
  expect(screen.getByRole("button", { name: /move to its own identity/i })).not.toHaveProperty(
    "disabled",
    true
  );
});
