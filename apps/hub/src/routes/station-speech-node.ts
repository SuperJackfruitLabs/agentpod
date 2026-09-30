/**
 * A node reads its station's spoken-reply setting.
 *
 *   POST /api/nodes/:nodeId/stations/:stationId/speech
 *
 * A harness-mode station is its own Matrix client and speaks its replies
 * itself, so the hub's speech setting reaches it only by being written into
 * its harness profile. The console asks the node to do that with
 * `speech.apply` (routes/speech-settings.ts); that broker frame carries the
 * station key and id and nothing else, and the node then fetches the setting
 * — API key included — here, with its own credential. The same split
 * `transcription.apply` and `station-transcription-node.ts` use: no secret
 * ever rides in a broker frame.
 *
 * **Authentication is copied from `station-transcription-node.ts`** (itself
 * from `station-matrix-credential.ts`): `Bearer <nodeId>:<nodeSecret>`, a
 * credential that verifies for a different node than the path names is
 * refused exactly like a wrong secret (401), and a station that does not
 * exist is refused exactly like one hosted by another node (403), so a node
 * cannot probe other nodes' station ids.
 *
 * Not single-use: it is a read of the current configuration, answered from
 * `resolveSpeechFor` (station custom > station off > hub setting > SPEECH_*
 * env; voice and speak mode resolved on their own). A station with no speech
 * service answers `{ enabled: false }`. `maxChars` is not sent: Hermes has no
 * setting that cuts a reply short (it splits a long one into several clips),
 * so the node would have nowhere to put it.
 *
 * The key is never logged; the audit line names the station, node, source,
 * voice and speak mode only.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { verifyNodeCredential } from "../services/enrollment";
import { resolveSpeechFor, type ResolvedSpeech } from "../services/speech-settings";

export interface NodeSpeechDeps {
  /** Injected by tests; defaults to the speech settings resolver. */
  resolve?: (stationId: string) => Promise<ResolvedSpeech | null>;
  /** Injected so the tests can prove a key never reaches it. */
  log?: (line: string) => void;
}

export function createNodeSpeechRoutes(deps: NodeSpeechDeps = {}) {
  const resolve = deps.resolve ?? resolveSpeechFor;
  const say = deps.log ?? ((line: string) => console.log(line));

  return new Hono().post("/nodes/:nodeId/stations/:stationId/speech", async (c) => {
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
      say(`[station-speech] node ${nodeId} read station ${stationId}'s speech: off`);
      return c.json({ enabled: false as const });
    }

    // Audited, and never with the key in it.
    say(
      `[station-speech] node ${nodeId} read station ${stationId}'s speech ` +
        `(source ${setting.source}, voice ${setting.voice}, speak ${setting.speakMode})`
    );
    return c.json({
      enabled: true as const,
      url: setting.url,
      apiKey: setting.apiKey,
      voice: setting.voice,
      speakMode: setting.speakMode,
    });
  });
}
