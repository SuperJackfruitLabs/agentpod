/** Proposed default-off callback authenticated with the enrolled Node credential. */
import { Hono } from "hono";
import { verifyNodeCredential } from "../services/nodes";
import { checkpointCurrentDecision, CHECKPOINT_COORDINATOR_FLAG } from "../services/bridge";

export const checkpointCurrentRoutes = new Hono().post("/nodes/:nodeId/bench-coordinator/current", async (c) => {
  c.header("Cache-Control", "no-store");
  if (process.env[CHECKPOINT_COORDINATOR_FLAG] !== "true") return c.json({ error: "not found" }, 404);
  const nodeId = c.req.param("nodeId");
  const auth = c.req.header("Authorization") ?? "";
  const match = /^Bearer ([^: ]+):([^\r\n]+)$/.exec(auth);
  if (!match?.[2] || match[1] !== nodeId || !(await verifyNodeCredential(nodeId, match[2])))
    return c.json({ error: "invalid node credential" }, 401);
  if (c.req.header("content-type")?.split(";")[0]?.trim() !== "application/json")
    return c.json({ error: "invalid checkpoint request" }, 400);
  const reader = c.req.raw.body?.getReader();
  if (!reader) return c.json({ error: "invalid checkpoint request" }, 400);
  const bodyDeadline = setTimeout(() => { void reader.cancel().catch(() => {}); }, 5000);
  try {
    const parts: Uint8Array[] = []; let count = 0;
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      count += chunk.value.byteLength;
      if (count > 65536) return c.json({ error: "invalid checkpoint request" }, 413);
      parts.push(chunk.value);
    }
    const raw = new Uint8Array(count); let offset = 0;
    for (const part of parts) { raw.set(part, offset); offset += part.byteLength; }
    return c.json(await checkpointCurrentDecision(nodeId, raw));
  } catch { return c.json({ error: "invalid checkpoint request" }, 400); }
  finally { clearTimeout(bodyDeadline); await reader.cancel().catch(() => {}); reader.releaseLock(); }
});
