/**
 * ContextRail — who the agent is, where it runs, who may dispatch it.
 *
 * The load-bearing cases:
 *   - credential mode is rendered as a sentence, not as a mode string;
 *   - `GET /api/admin/grants` is admin-only and is NOT called otherwise — a
 *     403 on every station visit would be noise in the hub's log that tells
 *     the operator nothing;
 *   - a station nobody occupies asks for no grants at all, because no grant
 *     can name it.
 *
 * Run: cd apps/console && pnpm test src/lib/components/shell/ContextRail
 */

import { test, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/svelte";
import * as api from "$lib/api/client";
import type { StationRow } from "$lib/api/client";
import type { NodeSummary } from "@agentpod/contract";
import ContextRail from "./ContextRail.svelte";

afterEach(cleanup);

function station(over: Partial<StationRow> = {}): StationRow {
  return {
    id: "station_1",
    userId: "user_1",
    nodeId: "node_1",
    harness: "claude",
    stationKey: "claude://workspace",
    kind: "composite",
    parentStationId: null,
    displayName: "hermes",
    workspacePath: "/home/user/workspace",
    capabilities: ["acp"],
    matrixId: null,
    bridgeMatrixId: null,
    purpose: null,
    principalId: null,
    adoptedAt: "2026-06-22T00:00:00Z",
    createdAt: "2026-06-22T00:00:00Z",
    ...over,
  };
}

const node: NodeSummary = {
  id: "node_1",
  name: "orion",
  hostname: "orion.local",
  os: "darwin",
  arch: "arm64",
  cpuCount: 8,
  status: "online",
  lastSeenAt: "2026-06-22T00:00:00Z",
  createdAt: "2026-06-22T00:00:00Z",
  agentVersion: "v0.1.32",
  latestVersion: "v0.1.32",
  updateAvailable: false,
};

// ─── credential mode ────────────────────────────────────────────────────────

test("a harness-mode station says the credential is held by the agent itself", async () => {
  // The panel that shares this fact asks the hub where the move stands; the
  // rail's sentence does not depend on the answer, so it is stubbed away.
  vi.spyOn(api, "stationMoveState").mockResolvedValue({ status: "unknown" });

  const { getByTestId } = render(ContextRail, {
    props: { station: station({ matrixId: "@hermes:example.org" }), node },
  });

  expect(getByTestId("rail-credential-mode").textContent).toContain("Held by the agent itself");
});

test("a bridge-mode station says the bridge speaks for it", () => {
  const { getByTestId } = render(ContextRail, { props: { station: station(), node } });

  expect(getByTestId("rail-credential-mode").textContent).toContain("The bridge speaks for it");
});

// ─── identity and placement ─────────────────────────────────────────────────

test("the machine-issued facts are mono and breakable", () => {
  // A mxid, a prn_ id and a station key are all long and unbreakable; without
  // break-all one of them widens the 320px column and, with it, the document.
  const { getByTestId } = render(ContextRail, {
    props: {
      station: station({ principalId: "prn_0123456789abcdef0123" }),
      node,
    },
  });

  for (const id of ["rail-handle", "rail-mxid", "rail-principal", "rail-station-key"]) {
    expect(getByTestId(id).className).toContain("font-mono");
    expect(getByTestId(id).className).toContain("break-all");
  }
  expect(getByTestId("rail-station-key").textContent).toContain("claude://workspace");
  expect(getByTestId("rail-agent-version").textContent).toContain("v0.1.32");
});

// ─── who may dispatch it ────────────────────────────────────────────────────

test("a non-admin is told the grant isn't theirs to see, and the endpoint is never called", async () => {
  const listGrants = vi.fn();
  const listPrincipals = vi.fn();

  const { getByTestId } = render(ContextRail, {
    props: {
      station: station({ principalId: "prn_0123456789abcdef0123" }),
      node,
      isAdmin: false,
      listGrants,
      listPrincipals,
    },
  });

  expect(getByTestId("rail-grant-not-visible").textContent).toContain("not visible to you");
  // Not "eventually" — never. A 403 per station visit is noise, not a feature.
  await new Promise((r) => setTimeout(r, 10));
  expect(listGrants).not.toHaveBeenCalled();
  expect(listPrincipals).not.toHaveBeenCalled();
});

test("an admin sees the principals holding this agent, named by handle", async () => {
  const listGrants = vi.fn(async () => ({
    grants: [
      { principalId: "prn_aaaaaaaaaaaaaaaaaaaa", mayDispatch: ["prn_target"], mayGrantReach: true },
      { principalId: "prn_bbbbbbbbbbbbbbbbbbbb", mayDispatch: ["prn_someone_else"], mayGrantReach: false },
    ],
    enforced: true,
  }));
  const listPrincipals = vi.fn(async () => [
    {
      id: "prn_aaaaaaaaaaaaaaaaaaaa",
      kind: "human" as const,
      handle: "rakesh",
      displayName: null,
      userId: null,
      suspendedAt: null,
    },
  ]);

  const { getByTestId } = render(ContextRail, {
    props: {
      station: station({ principalId: "prn_target" }),
      node,
      isAdmin: true,
      listGrants,
      listPrincipals,
    },
  });

  await waitFor(() => {
    const rows = getByTestId("rail-dispatchers").textContent ?? "";
    expect(rows).toContain("rakesh");
    // The grant that names a different agent is not this agent's business.
    expect(rows).not.toContain("prn_bbbb");
  });
});

test("an unenforced hub says so, so a narrow grant isn't read as a locked fleet", async () => {
  const listGrants = vi.fn(async () => ({
    grants: [
      { principalId: "prn_aaaaaaaaaaaaaaaaaaaa", mayDispatch: ["prn_target"], mayGrantReach: true },
    ],
    enforced: false,
  }));

  const { findByText } = render(ContextRail, {
    props: {
      station: station({ principalId: "prn_target" }),
      node,
      isAdmin: true,
      listGrants,
      listPrincipals: vi.fn(async () => []),
    },
  });

  expect(await findByText("Nothing is enforcing grants on this hub yet.")).toBeTruthy();
});

test("a station nobody occupies asks for no grants", async () => {
  const listGrants = vi.fn();

  const { getByTestId } = render(ContextRail, {
    props: { station: station({ principalId: null }), node, isAdmin: true, listGrants },
  });

  expect(getByTestId("rail-dispatch").textContent).toContain("this station has no agent in it");
  await new Promise((r) => setTimeout(r, 10));
  expect(listGrants).not.toHaveBeenCalled();
});

test("with no station it says so rather than rendering empty sections", () => {
  const { getByTestId, queryByTestId } = render(ContextRail, { props: { station: null } });

  expect(getByTestId("station-context").textContent).toContain("Nothing selected");
  expect(queryByTestId("rail-identity")).toBeNull();
});

test("the rail root is positioned, so an sr-only descendant can't widen the document", () => {
  // The shell's context column is a scroller. `sr-only` is position:absolute,
  // and with no positioned ancestor inside that scroller its containing block
  // is the initial one — it escapes the clipping and adds to the document's
  // scroll width. That has already broken two pages in this redesign.
  const { getByTestId } = render(ContextRail, { props: { station: station(), node } });

  expect(getByTestId("station-context").className).toContain("relative");
});
