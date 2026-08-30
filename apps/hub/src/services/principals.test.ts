/**
 * Service Test: principals (mint + Better Auth lookup)
 *
 * Uses the local Docker test-postgres (localhost:5434).
 * DATABASE_URL must be set before any src/ modules are imported.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll } from "bun:test";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createPrincipal, principalForUser } from "./principals";

beforeAll(async () => {
  await ensurePgMigrations();
});

describe("principals", () => {
  test("mints an agent principal with a grammar-valid id", async () => {
    const id = await createPrincipal({ kind: "agent", handle: "writer-quill" });
    expect(id).toMatch(/^prn_[0-9a-f]{20}$/);
  });

  test("refuses a second principal on the same handle", async () => {
    await createPrincipal({ kind: "agent", handle: "analyst-echo" });
    // A handle is an address: two claimants make the mxid it produces ambiguous.
    expect(createPrincipal({ kind: "agent", handle: "analyst-echo" })).rejects.toThrow();
  });

  test("finds the principal behind a Better Auth user", async () => {
    const id = await createPrincipal({ kind: "human", handle: "rakesh", userId: "usr-uuid-here" });
    const found = await principalForUser("usr-uuid-here");
    expect(found?.id).toBe(id);
    expect(found?.kind).toBe("human");
  });

  test("a user with no principal resolves to null, never to a default", async () => {
    // Falling back would hand one principal's authority to an unmapped caller.
    expect(await principalForUser("usr-nobody")).toBeNull();
  });
});
