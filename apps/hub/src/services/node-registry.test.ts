/**
 * Unit test: annotateWithVersion updateAvailable logic.
 *
 * Pure function — no DB. DATABASE_URL is set defensively because importing
 * node-registry pulls in db/drizzle (which builds a lazy postgres client but
 * does not connect at import).
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect } from "bun:test";
import { annotateWithVersion } from "./node-registry";

test("updateAvailable is true only when the node is BEHIND the latest version", () => {
  const rows = [
    { agentVersion: "v0.1.7" }, // behind v0.1.9 → update available
    { agentVersion: "v0.1.9" }, // equal → no update
    { agentVersion: "v0.2.0" }, // AHEAD of a stale cached latest → NOT a downgrade prompt
    { agentVersion: null }, // unknown → no update
  ];

  const out = annotateWithVersion(rows, "v0.1.9");

  expect(out.map((n) => n.updateAvailable)).toEqual([true, false, false, false]);
  // latestVersion is still surfaced on every row.
  expect(out.every((n) => n.latestVersion === "v0.1.9")).toBe(true);
});

test("updateAvailable is false when latestVersion is unknown (null)", () => {
  const out = annotateWithVersion([{ agentVersion: "v0.1.7" }], null);
  expect(out.map((n) => n.updateAvailable)).toEqual([false]);
});

test("version ordering is numeric, not lexical (v0.1.10 is newer than v0.1.9)", () => {
  const out = annotateWithVersion([{ agentVersion: "v0.1.9" }], "v0.1.10");
  expect(out.map((n) => n.updateAvailable)).toEqual([true]);
});

test("a build that reports no release version ('dev') is NOT current", () => {
  // A node built without a version stamp reports the literal "dev". The node's
  // own updater treats an unreadable version as not up to date (selfupdate's
  // upToDate), so the hub saying "up to date" both hid the drift and made a
  // rollout skip a node that would have accepted the update.
  const out = annotateWithVersion(
    [{ agentVersion: "dev" }, { agentVersion: "v0.1.9-3-gabc1234" }, { agentVersion: null }],
    "v0.1.9"
  );
  // A `git describe` stamp is a real version: v0.1.9 plus commits, not behind.
  expect(out.map((n) => n.updateAvailable)).toEqual([true, false, false]);
});
