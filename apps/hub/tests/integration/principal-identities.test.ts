import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { rawSql } from "../../src/db/drizzle";
import { createPrincipal } from "../../src/services/principals";
import {
  linkIdentity,
  identitiesFor,
  principalByExternal,
  externalIdFor,
  unlinkIdentity,
} from "../../src/services/principal-identities";

/**
 * Identity mappings — Phase 2 of docs/superpowers/plans/2026-08-15-organization-layer.md.
 *
 * What is blocked on this: an Application Service bridge cannot attribute a
 * Matrix message to a principal, approvals-from-chat cannot carry their sender,
 * and supermessage's decision row stays unreachable. All three need one
 * question answered — given an mxid, who is this — and its reverse.
 *
 * The station half already works: `stations.matrix_id` has been populated since
 * 2026-08-15 (14 Hermes stations). This is the principal half.
 *
 * These are principals, not Better Auth users. `principal_identities.principal_id`
 * is a foreign key onto `principals.id` now: a Better Auth id in it is not a
 * mapping keyed the old way, it is a row that cannot be written. A principal's
 * Better Auth login is simply one more identity in this same table, which is
 * what `createPrincipal({ userId })` links.
 */

const HANDLE_A = "identities-it-a";
const HANDLE_B = "identities-it-b";
const HANDLE_C = "identities-it-c";
let PRINCIPAL_A: string;
let PRINCIPAL_B: string;

beforeAll(async () => {
  await ensurePgMigrations();
  await rawSql`DELETE FROM principals WHERE handle IN (${HANDLE_A}, ${HANDLE_B}, ${HANDLE_C})`;
  PRINCIPAL_A = await createPrincipal({ kind: "human", handle: HANDLE_A });
  PRINCIPAL_B = await createPrincipal({ kind: "human", handle: HANDLE_B });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM principals WHERE handle IN (${HANDLE_A}, ${HANDLE_B}, ${HANDLE_C})`;
  } catch {
    // cleanup only
  }
});

describe("principal identities", () => {
  test("links a principal to a Matrix id and resolves both directions", async () => {
    await linkIdentity(PRINCIPAL_A, "matrix", "@olivia:id.agentpod.dev");

    expect(await principalByExternal("matrix", "@olivia:id.agentpod.dev")).toBe(PRINCIPAL_A);
    expect(await externalIdFor(PRINCIPAL_A, "matrix")).toBe("@olivia:id.agentpod.dev");
  });

  test("answers unknown rather than guessing", async () => {
    // An unmapped identity must degrade, not fail: most principals have no
    // Matrix account and never will, and a bridge asking about one is not an
    // error condition.
    expect(await principalByExternal("matrix", "@nobody:id.agentpod.dev")).toBeNull();
    expect(await externalIdFor(PRINCIPAL_B, "matrix")).toBeNull();
  });

  test("refuses to let two principals claim one external identity", async () => {
    // The constraint that makes this table usable for what it exists for. Two
    // principals claiming one mxid makes "who sent this" unanswerable exactly
    // when it matters — attributing a human's approval, which must carry its
    // sender or kaambaan's separation-of-duties check is void.
    await expect(
      linkIdentity(PRINCIPAL_B, "matrix", "@olivia:id.agentpod.dev")
    ).rejects.toThrow();

    expect(await principalByExternal("matrix", "@olivia:id.agentpod.dev")).toBe(PRINCIPAL_A);
  });

  test("a principal has at most one identity per system", async () => {
    // The reverse direction needs a single answer too: "which mxid do I message
    // this principal at" cannot return three.
    await expect(
      linkIdentity(PRINCIPAL_A, "matrix", "@olivia-alt:id.agentpod.dev")
    ).rejects.toThrow();
  });

  test("holds several systems for one principal", async () => {
    await linkIdentity(PRINCIPAL_A, "kaambaan", "usr_kaambaan_a");

    const all = await identitiesFor(PRINCIPAL_A);
    expect(all.map((i) => i.system).sort()).toEqual(["kaambaan", "matrix"]);
  });

  test("refuses an unknown system", async () => {
    // A typo'd system name would create a mapping nothing ever reads — a row
    // that looks like a link and is not one.
    await expect(
      linkIdentity(PRINCIPAL_B, "matrix-ish" as never, "@b:id.agentpod.dev")
    ).rejects.toThrow();
  });

  test("refuses an empty external id", async () => {
    await expect(linkIdentity(PRINCIPAL_B, "matrix", "")).rejects.toThrow();
  });

  test("unlinking is idempotent and scoped to one system", async () => {
    await unlinkIdentity(PRINCIPAL_A, "kaambaan");
    expect(await externalIdFor(PRINCIPAL_A, "kaambaan")).toBeNull();
    // Still there — unlinking one system must not touch another.
    expect(await externalIdFor(PRINCIPAL_A, "matrix")).toBe("@olivia:id.agentpod.dev");

    await unlinkIdentity(PRINCIPAL_A, "kaambaan"); // again: no throw
  });

  test("deleting a principal takes its identities with it", async () => {
    // No orphan rows pointing at a principal that no longer exists — an
    // identity outliving its principal is a mapping to nothing that still
    // occupies its external id, so the next person to link that mxid is
    // refused for a reason nobody can see.
    const gone = await createPrincipal({ kind: "human", handle: HANDLE_C });
    await linkIdentity(gone, "matrix", "@gone:id.agentpod.dev");

    await rawSql`DELETE FROM principals WHERE id = ${gone}`;

    expect(await principalByExternal("matrix", "@gone:id.agentpod.dev")).toBeNull();
  });
});
