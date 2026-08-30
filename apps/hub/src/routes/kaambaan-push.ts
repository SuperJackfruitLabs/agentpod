/**
 * POST /public/bridge/kaambaan/push — how a board tells the hub a gate is open.
 *
 * **Public**, and mounted outside `/api/*` deliberately: the caller is a
 * Cloudflare Worker holding a shared signing secret, not a browser holding a
 * session, and `/api/*` carries the CSRF middleware — which passes a `Bearer`
 * header and would reject this. `/public` is where this codebase already puts
 * "a machine with a secret" (see `runtime-callback.ts`), so it goes there
 * rather than carving an exemption into a security middleware.
 *
 * Authentication is kaambaan's own outbound signature — HMAC-SHA256 over the
 * exact request bytes, `sha256=<hex>` in `X-Kaambaan-Signature`, the same
 * scheme its inbound GitHub verifier uses. The bytes are read once and hashed
 * before being parsed, because a signature over a re-serialized object is a
 * signature over something the sender never sent.
 *
 * Fails closed with no configured secret: an unset secret must never mean
 * "accept anything", which is the shape of the mistake that makes a webhook a
 * public write endpoint.
 */

import { Hono } from "hono";

import { createLogger } from "../utils/logger";
import {
  isGatePending,
  projectGate,
  type GatePendingDelivery,
  type GateProjectionDeps,
} from "../services/matrix-as/gates";

const log = createLogger("kaambaan-push");

export interface KaambaanPushDeps extends GateProjectionDeps {
  /** The signing secret shared with the board's push config. */
  secret: string | undefined;
  /** Which fleet this board's gates belong to. */
  tenantIdFor(boardId: string): Promise<string | null>;
}

const enc = new TextEncoder();

async function signatureMatches(secret: string, raw: string, header: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  const expected = `sha256=${[...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
  if (expected.length !== header.length) return false;
  // Constant time: a length-independent early return leaks the prefix, which is
  // enough to forge a signature one nibble at a time.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  }
  return diff === 0;
}

export function createKaambaanPushRoutes(deps: KaambaanPushDeps) {
  return new Hono().post("/bridge/kaambaan/push", async (c) => {
    if (!deps.secret) {
      log.warn("push rejected: no signing secret configured");
      return c.json({ error: "not configured" }, 503);
    }

    const signature = c.req.header("X-Kaambaan-Signature");
    if (!signature) return c.json({ error: "unsigned" }, 401);

    // Read the bytes once, verify those, and only then parse them.
    const raw = await c.req.text();
    if (!(await signatureMatches(deps.secret, raw, signature))) {
      log.warn("push rejected: bad signature", { bytes: raw.length });
      return c.json({ error: "bad signature" }, 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      // A retry does not fix malformed JSON, so this is terminal on purpose.
      return c.json({ error: "invalid json" }, 400);
    }

    if (!isGatePending(body)) {
      // Another event kaambaan pushes — work.available, gate.resolved — or a
      // shape this build does not know. 200, because it was delivered fine and
      // a non-2xx would make the board retry something it will never like.
      return c.json({ ok: true, ignored: true }, 200);
    }

    const tenantId = await deps.tenantIdFor(body.boardId);
    if (!tenantId) {
      log.warn("push for a board mapped to no fleet", { boardId: body.boardId });
      return c.json({ error: "unknown board" }, 404);
    }

    const outcome = await projectGate(tenantId, body, deps);
    log.info("gate projected", { gateId: body.gateId, status: outcome.status });
    return c.json({ ok: true, status: outcome.status }, 200);
  });
}
