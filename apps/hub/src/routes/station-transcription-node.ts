/**
 * A node reads its station's voice-note transcription setting.
 *
 *   POST /api/nodes/:nodeId/stations/:stationId/transcription
 *
 * A harness-mode station runs its own Matrix client and transcribes voice
 * notes itself, so the hub's setting reaches it only by being written into
 * its harness profile. The console asks the node to do that with
 * `transcription.apply` (routes/transcription-settings.ts); that broker frame
 * carries the station key and id and nothing else, and the node then fetches
 * the setting — API key included — here, with its own credential. The same
 * split `matrix.adopt` and `station-matrix-credential.ts` use: no secret ever
 * rides in a broker frame.
 *
 * **Authentication is copied from `station-matrix-credential.ts`**: `Bearer
 * <nodeId>:<nodeSecret>`, a credential that verifies for a different node than
 * the path names is refused exactly like a wrong secret (401), and a station
 * that does not exist is refused exactly like one hosted by another node
 * (403), so a node cannot probe other nodes' station ids.
 *
 * Unlike the Matrix credential this is **not single-use**: it is a read of
 * the current configuration, answered from `resolveTranscriptionFor` (station
 * custom > station off > hub setting > TRANSCRIBE_* env). A station with none
 * answers `{ enabled: false }`.
 *
 * The key is never logged; the audit line names the station, node, source and
 * model only.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { verifyNodeCredential } from "../services/enrollment";
import {
  resolveTranscriptionFor,
  type ResolvedTranscription,
} from "../services/transcription-settings";

export interface NodeTranscriptionDeps {
  /** Injected by tests; defaults to Phase A's resolver. */
  resolve?: (stationId: string) => Promise<ResolvedTranscription | null>;
  /** Injected so the tests can prove a key never reaches it. */
  log?: (line: string) => void;
}

export function createNodeTranscriptionRoutes(deps: NodeTranscriptionDeps = {}) {
  const resolve = deps.resolve ?? resolveTranscriptionFor;
  const say = deps.log ?? ((line: string) => console.log(line));

  return new Hono().post("/nodes/:nodeId/stations/:stationId/transcription", async (c) => {
    const nodeId = c.req.param("nodeId");
    const stationId = c.req.param("stationId");

    const auth = c.req.header("Authorization") ?? "";
    const bearer = auth.replace(/^Bearer\s+/, "");
    const idx = bearer.indexOf(":");
    const credNodeId = idx !== -1 ? bearer.slice(0, idx) : "";
    const nodeSecret = idx !== -1 ? bearer.slice(idx + 1) : "";

    if (
      !credNodeId ||
      !nodeSecret ||
      credNodeId !== nodeId ||
      !(await verifyNodeCredential(credNodeId, nodeSecret))
    ) {
      return c.json({ error: "invalid node credential" }, 401);
    }

    const [station] = await db
      .select({ id: stations.id, nodeId: stations.nodeId })
      .from(stations)
      .where(eq(stations.id, stationId));

    if (!station || station.nodeId !== nodeId) {
      return c.json({ error: "station not hosted by this node" }, 403);
    }

    const setting = await resolve(stationId);
    if (!setting) {
      say(`[station-transcription] node ${nodeId} read station ${stationId}'s transcription: off`);
      return c.json({ enabled: false as const });
    }

    // Audited, and never with the key in it.
    say(
      `[station-transcription] node ${nodeId} read station ${stationId}'s transcription ` +
        `(source ${setting.source}, model ${setting.model})`
    );
    return c.json({
      enabled: true as const,
      url: setting.url,
      apiKey: setting.apiKey,
      model: setting.model,
    });
  });
}
