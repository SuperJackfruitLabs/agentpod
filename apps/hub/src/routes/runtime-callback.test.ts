/**
 * Integration Test: runtime callback route.
 *
 * How a substrate tells the hub it idled a runtime out. Cloudflare sleeps
 * containers on its own timer, so without this the hub sees only a node that
 * stopped heartbeating and cannot distinguish "slept normally" from "died".
 *
 * Uses the local Docker test-postgres (localhost:5434).
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
process.env.RUNTIME_CALLBACK_TOKEN = "cbtok";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { db, rawSql } from "../db/drizzle";
import { provisionedRuntimes } from "../db/schema/nodes";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { runtimeCallbackRoutes } from "./runtime-callback";

const TEST_USER = "test-user-rt-callback-001";

const app = new Hono().route("/public", runtimeCallbackRoutes);

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "rt-callback-test@example.com",
    name: "Runtime Callback Test User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM provisioned_runtimes WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM "user"              WHERE id      = ${TEST_USER}`;
  } catch {
    // ignore
  }
});

async function seedRuntime(): Promise<string> {
  const id = `rt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await rawSql`
    INSERT INTO provisioned_runtimes (id, user_id, provider, status, name, resource_tier, harness, created_at, updated_at)
    VALUES (${id}, ${TEST_USER}, 'cloudflare', 'online', 'callback-test', 'small', 'none', now(), now())
  `;
  return id;
}

const post = (id: string, body: unknown, token?: string) =>
  app.request(`/public/runtimes/${id}/state`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

test("a valid callback marks the runtime asleep", async () => {
  // The whole point: only the worker knows a container idled out, so it tells us.
  const id = await seedRuntime();
  const res = await post(id, { state: "asleep" }, "cbtok");
  expect(res.status).toBe(200);

  const [row] = await db
    .select()
    .from(provisionedRuntimes)
    .where(eq(provisionedRuntimes.id, id));
  expect(row?.status).toBe("asleep");
});

test("an unauthenticated callback is refused", async () => {
  // This endpoint is public — it must be reachable by a container with no
  // session. A missing token must therefore fail closed, or anyone could mark
  // another user's runtime asleep.
  const id = await seedRuntime();
  const res = await post(id, { state: "asleep" });
  expect(res.status).toBe(401);
});

test("a wrong token is refused", async () => {
  const id = await seedRuntime();
  const res = await post(id, { state: "asleep" }, "nope");
  expect(res.status).toBe(401);
});

test("an unknown runtime is a 404, not a silent success", async () => {
  const res = await post("rt_nope", { state: "asleep" }, "cbtok");
  expect(res.status).toBe(404);
});

test("only asleep is accepted", async () => {
  // The callback is not a general status-setting API. A container must not be
  // able to declare itself destroyed or online.
  const id = await seedRuntime();
  for (const state of ["destroyed", "online", "error", "stopped"]) {
    const res = await post(id, { state }, "cbtok");
    expect(res.status).toBe(400);
  }

  const [row] = await db
    .select()
    .from(provisionedRuntimes)
    .where(eq(provisionedRuntimes.id, id));
  expect(row?.status).toBe("online");
});
