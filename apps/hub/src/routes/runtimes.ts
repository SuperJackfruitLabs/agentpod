/**
 * Fleet-era runtime provisioning routes (P4 Task 8).
 *
 * All routes are authenticated (mounted under /api/* which is guarded by authMiddleware).
 * User identity comes from `c.get("user")` — same pattern as enrollment-tokens.ts.
 *
 * Routes:
 *   POST   /api/runtimes                — create a new runtime (body: ProvisionRequest)
 *   GET    /api/runtimes                — list the caller's runtimes
 *   GET    /api/runtimes/providers      — list enabled providers (for UI)
 *   DELETE /api/runtimes/:id            — destroy a runtime
 *   POST   /api/runtimes/:id/start      — start a stopped runtime
 *   POST   /api/runtimes/:id/stop       — stop a running runtime
 *
 * Status codes:
 *   201 — runtime created
 *   200 — list / providers
 *   204 — destroy/start/stop success
 *   400 — disabled provider OR body validation error OR unsupported operation
 *   401 — unauthenticated (enforced by authMiddleware in index.ts)
 *   404 — runtime not found / wrong owner
 *   502 — driver (external system) failure during provision/destroy
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { ProvisionRequest } from "@agentpod/contract";
import {
  createRuntime,
  listRuntimes,
  destroyRuntime,
  startRuntime,
  stopRuntime,
  enabledProviders,
  providerCapabilities,
} from "../services/runtimes";

export const runtimeRoutes = new Hono()

  // ── POST /api/runtimes ────────────────────────────────────────────────────
  .post("/", zValidator("json", ProvisionRequest), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    // Resolve the hub URL — prefer env override (set in production / tests),
    // fall back to the origin of the incoming request.
    const hubUrl =
      process.env.PROVISIONING_HUB_URL ?? new URL(c.req.url).origin;

    try {
      const runtime = await createRuntime(user.id, body, hubUrl);
      return c.json(runtime, 201);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 400) {
        return c.json({ error: "Bad Request", message: e.message }, 400);
      }
      if (e.status === 502) {
        return c.json(
          { error: "Bad Gateway", message: "The provisioning driver failed" },
          502
        );
      }
      throw err; // Let the global error handler deal with unexpected errors
    }
  })

  // ── GET /api/runtimes/providers ───────────────────────────────────────────
  // Must be registered BEFORE /:id to avoid being shadowed.
  .get("/providers", (c) => {
    return c.json({ providers: enabledProviders(), capabilities: providerCapabilities() });
  })

  // ── GET /api/runtimes ─────────────────────────────────────────────────────
  .get("/", async (c) => {
    const user = c.get("user");
    const runtimes = await listRuntimes(user.id);
    return c.json(runtimes);
  })

  // ── DELETE /api/runtimes/:id ──────────────────────────────────────────────
  .delete("/:id", async (c) => {
    const user = c.get("user");
    const { id } = c.req.param();

    try {
      await destroyRuntime(user.id, id);
      return c.body(null, 204);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 404) {
        return c.json({ error: "Not Found", message: e.message }, 404);
      }
      if (e.status === 502) {
        return c.json(
          { error: "Bad Gateway", message: "The destroy driver call failed" },
          502
        );
      }
      throw err;
    }
  })

  // ── POST /api/runtimes/:id/start ─────────────────────────────────────────
  .post("/:id/start", async (c) => {
    const user = c.get("user");
    const { id } = c.req.param();

    try {
      await startRuntime(user.id, id);
      return c.body(null, 204);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 404) {
        return c.json({ error: "Not Found", message: e.message }, 404);
      }
      if (e.status === 400) {
        return c.json({ error: "Bad Request", message: e.message }, 400);
      }
      throw err;
    }
  })

  // ── POST /api/runtimes/:id/stop ──────────────────────────────────────────
  .post("/:id/stop", async (c) => {
    const user = c.get("user");
    const { id } = c.req.param();

    try {
      await stopRuntime(user.id, id);
      return c.body(null, 204);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 404) {
        return c.json({ error: "Not Found", message: e.message }, 404);
      }
      if (e.status === 400) {
        return c.json({ error: "Bad Request", message: e.message }, 400);
      }
      throw err;
    }
  });
