/**
 * Runtime Callback Route — POST /public/runtimes/:id/state
 *
 * How a substrate tells the hub that it idled a runtime out.
 *
 * Cloudflare sleeps containers on its own timer, so without this the hub sees
 * only that a node stopped heartbeating and cannot distinguish "slept normally"
 * from "died". Reporting a routine state as a fault is the failure shape this
 * codebase keeps hitting, so the substrate reports it instead of us guessing.
 *
 * **Public** — the caller is a container with no session — so it authenticates
 * with a shared bearer token and fails closed when none is configured.
 *
 * Deliberately narrow: `asleep` is the only accepted state. This is not a
 * general status-setting API, and a container must not be able to declare
 * itself destroyed or online.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { provisionedRuntimes } from "../db/schema/nodes";

export const runtimeCallbackRoutes = new Hono().post(
  "/runtimes/:id/state",
  async (c) => {
    const expected = process.env.RUNTIME_CALLBACK_TOKEN;
    const header = c.req.header("Authorization") ?? "";
    if (!expected || header !== `Bearer ${expected}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let body: { state?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    if (body.state !== "asleep") {
      return c.json({ error: "only 'asleep' may be reported" }, 400);
    }

    const id = c.req.param("id");
    const [row] = await db
      .select()
      .from(provisionedRuntimes)
      .where(eq(provisionedRuntimes.id, id));
    if (!row) {
      return c.json({ error: "Not Found" }, 404);
    }

    await db
      .update(provisionedRuntimes)
      .set({ status: "asleep", updatedAt: new Date() })
      .where(eq(provisionedRuntimes.id, id));

    return c.json({ ok: true });
  }
);
