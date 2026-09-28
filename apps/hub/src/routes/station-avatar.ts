/**
 * A workspace image as a station's Matrix profile picture.
 *
 *   POST /api/stations/:stationId/matrix-avatar   { path }   (owner)
 *
 * Two identities, two routes to the same result:
 *
 * - **harness mode** — the station holds its own Matrix account (every Guild
 *   agent). The hub's appservice token cannot act for it (403: it is outside
 *   the namespace), so the node does it with the login in the profile's .env
 *   (`matrix.avatar.set`). The frame carries a key and a path; the token never
 *   leaves the node.
 * - **bridge mode** — the identity is the appservice's own `@agent_…` user, so
 *   the hub reads the image through the node and sets it itself.
 *
 * Owner-scoped like the transcription routes: someone else's station is a 404.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { VERB_RESULTS } from "@agentpod/contract";
import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import * as broker from "../services/broker";
import { principalHandle } from "../services/principals";
import { stationSpeaker } from "../services/matrix-as/names";
import { createLogger } from "../utils/logger";
import { sniffImage } from "../utils/sniff-image";

export { sniffImage };

const log = createLogger("station-avatar");

export interface AvatarTarget {
  id: string;
  nodeId: string;
  stationKey: string;
  harness: string;
  matrixIdentityMode: string;
  /** The harness's own mxid, for a harness-mode station. */
  matrixId: string | null;
  principalId: string | null;
}

type BrokerRequest = (
  nodeId: string,
  verb: string,
  params: unknown,
  opts?: { timeoutMs?: number }
) => Promise<{ ok: boolean; data?: unknown; error?: string }>;

/** What bridge mode needs of the appservice. Absent when no bridge is configured. */
export interface AvatarBridge {
  /** The `@agent_…` user a bridge-mode station speaks as, or null. */
  speakerFor(target: AvatarTarget): Promise<string | null>;
  uploadImage(userId: string, bytes: Uint8Array, contentType: string): Promise<string | null>;
  setAvatar(userId: string, mxcUrl: string): Promise<void>;
}

export interface StationAvatarDeps {
  target?: (userId: string, stationId: string) => Promise<AvatarTarget | null>;
  brokerRequest?: BrokerRequest;
  bridge?: AvatarBridge;
}

/** The node reads, uploads and sets — one homeserver round trip each. */
export const MATRIX_AVATAR_TIMEOUT_MS = 60_000;

/** Kept in step with `matrixAvatarMaxBytes` in the node's matrixavatar.go. */
export const MATRIX_AVATAR_MAX_BYTES = 8 * 1024 * 1024;

/** Harnesses whose node-agent can find a Matrix login; the node's `matrixAvatarHarnesses`. */
const HARNESSES_WITH_MATRIX_LOGIN: ReadonlySet<string> = new Set(["hermes"]);

const Body = z.object({ path: z.string().min(1).max(4096) });

async function targetInDb(userId: string, stationId: string): Promise<AvatarTarget | null> {
  const [row] = await db
    .select({
      id: stations.id,
      nodeId: stations.nodeId,
      stationKey: stations.stationKey,
      harness: stations.harness,
      matrixIdentityMode: stations.matrixIdentityMode,
      matrixId: stations.matrixId,
      principalId: stations.principalId,
    })
    .from(stations)
    .where(and(eq(stations.id, stationId), eq(stations.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** The appservice's side of bridge mode, built from the running bridge. */
export function avatarBridgeFrom(bridge: {
  config: { domain: string };
  client: {
    uploadImage(userId: string, bytes: Uint8Array, contentType: string): Promise<string | null>;
    setAvatar(userId: string, mxcUrl: string): Promise<void>;
  };
}): AvatarBridge {
  return {
    async speakerFor(t) {
      const handle = t.principalId ? await principalHandle(t.principalId) : null;
      return stationSpeaker(
        { identityMode: t.matrixIdentityMode, harnessMxid: t.matrixId, handle },
        bridge.config.domain
      );
    },
    uploadImage: (userId, bytes, contentType) => bridge.client.uploadImage(userId, bytes, contentType),
    setAvatar: (userId, mxc) => bridge.client.setAvatar(userId, mxc),
  };
}

export function stationAvatarRoutes(deps: StationAvatarDeps = {}) {
  const target = deps.target ?? targetInDb;
  const request: BrokerRequest = deps.brokerRequest ?? broker.request;

  return new Hono().post("/stations/:stationId/matrix-avatar", zValidator("json", Body), async (c) => {
    const userId = c.get("user").id;
    const station = await target(userId, c.req.param("stationId"));
    if (!station) return c.json({ error: "Not Found" }, 404);
    const { path } = c.req.valid("json");

    if (station.matrixIdentityMode === "bridge") {
      if (!deps.bridge) {
        return c.json({ error: "This hub has no Matrix bridge configured, so it cannot set a bridge-mode agent's avatar." }, 503);
      }
      const speaker = await deps.bridge.speakerFor(station);
      if (!speaker) {
        return c.json({ error: "This station has no occupying agent, so it has no Matrix identity to set a picture for." }, 409);
      }

      const read = await request(
        station.nodeId,
        "fs.read",
        { key: station.stationKey, path, maxBytes: MATRIX_AVATAR_MAX_BYTES },
        { timeoutMs: MATRIX_AVATAR_TIMEOUT_MS }
      );
      if (!read.ok) return c.json({ error: read.error ?? "the node could not read the file" }, 502);
      const parsed = VERB_RESULTS["fs.read"].safeParse(read.data);
      if (!parsed.success) return c.json({ error: "invalid fs.read response from node" }, 502);
      if (parsed.data.truncated) {
        return c.json({ error: `The image is larger than ${MATRIX_AVATAR_MAX_BYTES >> 20} MB.` }, 413);
      }
      const bytes =
        parsed.data.encoding === "base64"
          ? Uint8Array.from(Buffer.from(parsed.data.content, "base64"))
          : new TextEncoder().encode(parsed.data.content);
      const contentType = sniffImage(bytes);
      if (!contentType) {
        return c.json({ error: "That file is not an image; use a PNG, JPEG, GIF or WebP." }, 400);
      }

      const mxc = await deps.bridge.uploadImage(speaker, bytes, contentType);
      if (!mxc) return c.json({ error: "The homeserver refused the upload." }, 502);
      await deps.bridge.setAvatar(speaker, mxc);
      log.info("set a bridge-mode agent's avatar from its workspace", { stationId: station.id, path });
      return c.json({ matrixId: speaker, mxc });
    }

    if (!station.matrixId) {
      return c.json({ error: "This station has no Matrix identity." }, 409);
    }
    if (!HARNESSES_WITH_MATRIX_LOGIN.has(station.harness)) {
      return c.json(
        { error: `Setting a ${station.harness} harness's Matrix avatar is not supported; only Hermes stations can.` },
        400
      );
    }

    const result = await request(
      station.nodeId,
      "matrix.avatar.set",
      { key: station.stationKey, path },
      { timeoutMs: MATRIX_AVATAR_TIMEOUT_MS }
    );
    if (!result.ok) {
      log.warn("a node could not set a station's Matrix avatar", {
        stationId: station.id,
        nodeId: station.nodeId,
        error: result.error,
      });
      return c.json({ error: result.error ?? "the node could not set the avatar" }, 502);
    }
    const parsed = VERB_RESULTS["matrix.avatar.set"].safeParse(result.data);
    if (!parsed.success) {
      return c.json(
        { error: "The node answered in a shape this hub does not understand — its node-agent may predate matrix.avatar.set." },
        502
      );
    }
    log.info("set a harness-mode agent's avatar from its workspace", { stationId: station.id, path });
    return c.json(parsed.data);
  });
}
