import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { adminPrincipalsRouter } from "../../src/routes/admin-principals";
import { adminMiddleware } from "../../src/auth/admin-middleware";
import { createPrincipal, principalById } from "../../src/services/principals";

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
const ADMIN_ACTOR = "test-admin-actor-principals";
const NON_ADMIN_ACTOR = "test-non-admin-actor-principals";

let HUMAN: string;
let AGENT: string;

interface Row {
  id: string;
  kind: string;
  handle: string;
  displayName: string | null;
  userId: string | null;
  suspendedAt: string | null;
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

/**
 * The real guard, not the stub above. `app()` fakes an already-admin context
 * so the other tests in this file can exercise the router in isolation; the
 * suspend/restore tests below need the actual `adminMiddleware` in the chain,
 * because "a non-admin cannot suspend" is a claim about that middleware, not
 * about the router.
 */
function guardedApp(actorId: string) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: actorId, authType: "api_key", tenantId: "default" });
    await next();
  });
  a.use("*", adminMiddleware);
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
  await createTestUser({
    id: ADMIN_ACTOR,
    email: "admin-principals-actor@example.com",
    name: "Actor",
    role: "admin",
  });
  await createTestUser({
    id: NON_ADMIN_ACTOR,
    email: "admin-principals-non-actor@example.com",
    name: "Non-actor",
  });
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
    await rawSql`DELETE FROM "user" WHERE id IN (${USER}, ${ADMIN_ACTOR}, ${NON_ADMIN_ACTOR})`;
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

  test("reports suspendedAt: null for a principal never suspended, in the same call", async () => {
    // The page must be able to show state without a second round trip.
    const found = (await list()).find((p) => p.id === HUMAN);
    expect(found!.suspendedAt).toBeNull();
  });
});

describe("POST /api/admin/principals/:id/suspend and /restore", () => {
  test("a non-admin cannot suspend a principal", async () => {
    const res = await guardedApp(NON_ADMIN_ACTOR).request(`/principals/${AGENT}/suspend`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect((await principalById(AGENT))!.suspendedAt).toBeNull();
  });

  test("a non-admin cannot restore a principal", async () => {
    const res = await guardedApp(NON_ADMIN_ACTOR).request(`/principals/${AGENT}/restore`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  test("an admin can suspend, and the directory reflects it in the same call", async () => {
    const res = await guardedApp(ADMIN_ACTOR).request(`/principals/${AGENT}/suspend`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; suspendedAt: string | null };
    expect(body.id).toBe(AGENT);
    expect(body.suspendedAt).not.toBeNull();

    const found = (await list()).find((p) => p.id === AGENT);
    expect(found!.suspendedAt).not.toBeNull();
  });

  test("suspending an already-suspended principal does not error", async () => {
    // An operator double-clicking is ordinary, not a fault.
    const res = await guardedApp(ADMIN_ACTOR).request(`/principals/${AGENT}/suspend`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
  });

  test("a re-suspend does not overwrite the original suspension time", async () => {
    // The column's own reason for existing (`db/schema/organization.ts`): "a
    // timestamp rather than a boolean, because 'since when' is the first
    // question asked of a suspension, and a boolean cannot answer it." An
    // unconditional UPDATE would answer that question with the time of the
    // *second* click — a stale tab, a retry, a race between two admins — and
    // nothing about the wrong answer would look wrong. Asserting only that the
    // second call doesn't error, as the test above does, is exactly what let
    // that through.
    const first = (await guardedApp(ADMIN_ACTOR).request(`/principals/${AGENT}/suspend`, {
      method: "POST",
    }).then((r) => r.json())) as { suspendedAt: string | null };
    expect(first.suspendedAt).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = (await guardedApp(ADMIN_ACTOR).request(`/principals/${AGENT}/suspend`, {
      method: "POST",
    }).then((r) => r.json())) as { suspendedAt: string | null };

    expect(second.suspendedAt).toBe(first.suspendedAt);
  });

  test("suspension is reversible from the same surface", async () => {
    const res = await guardedApp(ADMIN_ACTOR).request(`/principals/${AGENT}/restore`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; suspendedAt: string | null };
    expect(body.suspendedAt).toBeNull();

    const found = (await list()).find((p) => p.id === AGENT);
    expect(found!.suspendedAt).toBeNull();
  });

  test("restoring a principal that is not suspended does not error", async () => {
    const res = await guardedApp(ADMIN_ACTOR).request(`/principals/${AGENT}/restore`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
  });

  test("suspending an unknown principal id answers 404, not a silent no-op", async () => {
    const res = await guardedApp(ADMIN_ACTOR).request(
      "/principals/prn_ffffffffffffffffff00/suspend",
      { method: "POST" }
    );
    expect(res.status).toBe(404);
  });
});
