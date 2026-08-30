import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { adminPrincipalsRouter } from "../../src/routes/admin-principals";
import { createPrincipal } from "../../src/services/principals";

/**
 * The directory a grant is written against.
 *
 * A grant names a `prn_` id on both sides and nothing else in this API says
 * what those ids are. Without this list the console's grants page can offer
 * only a bare text box for a twenty-hex string — which is the same failure
 * `/api/admin/grants` was built to end: a control nobody can operate is one
 * people route around.
 *
 * Mounted under `/api/admin` in production, behind the same auth + admin
 * middleware as every other admin route; the guard is asserted at its mount
 * site, so this exercises the router itself.
 */

const USER = "test-user-admin-principals";
const HUMAN_HANDLE = "admin-principals-it-human";
const AGENT_HANDLE = "admin-principals-it-agent";

let HUMAN: string;
let AGENT: string;

interface Row {
  id: string;
  kind: string;
  handle: string;
  displayName: string | null;
  userId: string | null;
}

function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: "test-admin", role: "admin" });
    await next();
  });
  a.route("/principals", adminPrincipalsRouter);
  return a;
}

async function list(): Promise<Row[]> {
  const res = await app().request("/principals");
  expect(res.status).toBe(200);
  return ((await res.json()) as { principals: Row[] }).principals;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await rawSql`DELETE FROM principals WHERE handle IN (${HUMAN_HANDLE}, ${AGENT_HANDLE})`;
  await createTestUser({ id: USER, email: "admin-principals@example.com", name: "Directory" });
  HUMAN = await createPrincipal({
    kind: "human",
    handle: HUMAN_HANDLE,
    displayName: "Directory Person",
    userId: USER,
  });
  AGENT = await createPrincipal({ kind: "agent", handle: AGENT_HANDLE, displayName: "Quill" });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM principals WHERE handle IN (${HUMAN_HANDLE}, ${AGENT_HANDLE})`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

describe("/api/admin/principals", () => {
  test("lists an agent, which is the thing a grant's values name", async () => {
    // The half of the vocabulary that has no other source. A human principal
    // can at least be found through `/api/admin/users`; an agent appears in no
    // other admin list at all, so before this there was no way to discover the
    // id you were meant to type into `mayDispatch`.
    const found = (await list()).find((p) => p.id === AGENT);

    expect(found).toBeDefined();
    expect(found!.kind).toBe("agent");
    expect(found!.handle).toBe(AGENT_HANDLE);
  });

  test("an agent has no Better Auth login, and that is not a gap", async () => {
    // A console must be able to tell "this principal is a person you can look
    // up" from "this principal is an agent". Reading a missing login as a
    // missing row would drop every agent off the picker.
    const found = (await list()).find((p) => p.id === AGENT);

    expect(found!.userId).toBeNull();
  });

  test("carries a human principal's login, so a name can be put against it", async () => {
    // Otherwise the console has to join two id spaces itself and guess how —
    // which is the exact mistake that made every one of this slice's owner
    // lookups resolve to nothing.
    const found = (await list()).find((p) => p.id === HUMAN);

    expect(found!.kind).toBe("human");
    expect(found!.userId).toBe(USER);
    expect(found!.displayName).toBe("Directory Person");
  });
});
