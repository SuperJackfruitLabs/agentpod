import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { adminGrantsRouter } from "../../src/routes/admin-grants";
import { getGrant, setGrant } from "../../src/services/grants";

/**
 * The grants HTTP surface.
 *
 * Mounted under `/api/admin` in production, behind the same auth + admin
 * middleware as every other admin route; this exercises the router itself, so
 * the guard is asserted where it is mounted rather than mocked here.
 *
 * What these cover is the part a database client cannot: that the surface a
 * human types into refuses the values that would look like working grants and
 * silently permit nothing.
 */

const SUBJECT = "test-user-admin-grants";

/** The router, with a stub admin in context — the guard lives at the mount site. */
function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: "test-admin", role: "admin" });
    await next();
  });
  a.route("/grants", adminGrantsRouter);
  return a;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: SUBJECT, email: "admin-grants@example.com", name: "Subject" });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM principal_grants WHERE principal_id = ${SUBJECT}`;
    await rawSql`DELETE FROM "user" WHERE id = ${SUBJECT}`;
  } catch {
    // cleanup only
  }
});

describe("/api/admin/grants", () => {
  test("reports a principal with no grant as a blank slate, not a 404", async () => {
    // "This person has no permissions" is a real answer. A 404 would make a
    // console show an error where it should show an empty form.
    const res = await app().request(`/grants/${SUBJECT}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { granted: boolean; grant: { mayDispatch: string[] } };
    expect(body.granted).toBe(false);
    expect(body.grant.mayDispatch).toEqual([]);
  });

  test("sets and reads back a grant", async () => {
    const res = await app().request(`/grants/${SUBJECT}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mayDispatch: ["agentpod:molt-bot/hermes:*", "kaambaan:agt_x"],
        mayGrantReach: true,
      }),
    });
    expect(res.status).toBe(200);

    expect(await getGrant(SUBJECT)).toEqual({
      mayDispatch: ["agentpod:molt-bot/hermes:*", "kaambaan:agt_x"],
      mayGrantReach: true,
    });
  });

  test("refuses an unnamespaced value instead of storing a grant that matches nothing", async () => {
    // The retired `CONTROL_PAIR_GRANTS` format. A reader IGNORES a namespace it
    // does not recognise; a WRITER must refuse a malformed one — otherwise this
    // stores happily, matches nothing anywhere, and looks like a working grant,
    // which is the worst of the three outcomes.
    const res = await app().request(`/grants/${SUBJECT}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mayDispatch: ["hermes:*"], mayGrantReach: false }),
    });

    expect(res.status).toBe(400);
    // And the previous grant is untouched by a rejected write.
    expect((await getGrant(SUBJECT))!.mayGrantReach).toBe(true);
  });

  test("refuses a grant missing half the pair", async () => {
    const res = await app().request(`/grants/${SUBJECT}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mayDispatch: ["agentpod:molt-bot/hermes:*"] }),
    });
    expect(res.status).toBe(400);
  });

  test("replaces rather than merges, so narrowing is as easy as widening", async () => {
    await setGrant(SUBJECT, {
      mayDispatch: ["agentpod:molt-bot/hermes:*", "kaambaan:agt_x"],
      mayGrantReach: true,
    });

    await app().request(`/grants/${SUBJECT}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mayDispatch: ["agentpod:molt-bot/hermes:analyst-echo"], mayGrantReach: false }),
    });

    // A PATCH that merged arrays would make removing a permission harder than
    // adding one, and an authorization surface must never be easier to widen
    // than to narrow.
    expect(await getGrant(SUBJECT)).toEqual({
      mayDispatch: ["agentpod:molt-bot/hermes:analyst-echo"],
      mayGrantReach: false,
    });
  });

  test("lists every grant, which nothing else answers", async () => {
    const res = await app().request("/grants");
    const body = (await res.json()) as { grants: Array<{ principalId: string }> };
    expect(body.grants.some((g) => g.principalId === SUBJECT)).toBe(true);
  });

  test("says whether anything is actually enforcing these grants", async () => {
    // A console that showed grants without this would be showing a control that
    // may or may not be connected to anything: with `ENFORCE_CONTROL_PAIR`
    // unset, every grant here is recorded and nothing checks it. An operator
    // reading a narrow grant would believe the fleet was locked down when it was
    // wide open, which is the one wrong belief this page must never create.
    const before = process.env.ENFORCE_CONTROL_PAIR;
    try {
      process.env.ENFORCE_CONTROL_PAIR = "false";
      const off = (await (await app().request("/grants")).json()) as { enforced: boolean };
      expect(off.enforced).toBe(false);

      process.env.ENFORCE_CONTROL_PAIR = "true";
      const on = (await (await app().request("/grants")).json()) as { enforced: boolean };
      expect(on.enforced).toBe(true);
    } finally {
      if (before === undefined) delete process.env.ENFORCE_CONTROL_PAIR;
      else process.env.ENFORCE_CONTROL_PAIR = before;
    }
  });

  test("refuses an AgentPod value that names no node, because it matches nothing", async () => {
    // `agentpod:hermes:*` is the shape everyone writes first, and since the
    // amendment it matches no station on any node — uniqueness is (node, key).
    // Stored, it reads as a working grant and permits nothing, which is the
    // failure this writer exists to prevent. Fleet-wide has to be said out loud.
    const res = await app().request(`/grants/${SUBJECT}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mayDispatch: ["agentpod:hermes:*"], mayGrantReach: false }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/node/i);
  });

  test("accepts fleet-wide only when it is written out", async () => {
    const res = await app().request(`/grants/${SUBJECT}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false }),
    });
    expect(res.status).toBe(200);
  });

  test("removing a grant is not the same as emptying it", async () => {
    await app().request(`/grants/${SUBJECT}`, { method: "DELETE" });

    // Both deny under enforcement — that is the point — but they read
    // differently: empty says "considered, permitted nothing", absent says
    // "never considered".
    expect(await getGrant(SUBJECT)).toBeNull();

    const res = await app().request(`/grants/${SUBJECT}`);
    expect(((await res.json()) as { granted: boolean }).granted).toBe(false);
  });
});
