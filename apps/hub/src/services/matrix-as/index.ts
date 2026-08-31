/**
 * The Matrix bridge, assembled.
 *
 * Everything the bridge does is inert until the homeserver's registration file
 * carries a `url` pointing here. That is deliberate: the whole of Phase B can be
 * deployed with no effect, and turning it on is one field and one restart —
 * which is also the off switch.
 *
 * Gated on `ENABLE_MATRIX_BRIDGE` being the **literal lowercase `"true"`**,
 * matching `ENABLE_KAAMBAAN_BRIDGE` and `ENFORCE_CONTROL_PAIR`. This codebase has
 * already learned that a looser boolean lets `=1` pass validation and start
 * nothing.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { matrixRooms } from "../../db/schema/matrix";
import { principalIdentities } from "../../db/schema/identities";
import * as broker from "../broker";
import { createMatrixClient, type MatrixClient } from "./client";
import { provisionStation, provisionAll } from "./provision";
import { handleRoomMessage } from "./inbound";
import {
  handleGateDecision,
  projectionForGate,
  resolveGateAtKaambaan,
  roomAgentUser,
} from "./gates";
import { mintPrincipalAssertion } from "../../auth/service-signing";
import { resolveMatrixId } from "../matrix-identity";
import { principalForUser } from "../principals";
import { attachRoomToSession, noteTurnTrigger } from "./outbound";
import { createSession, promptSession,
  answerPermission } from "../acp-sessions";
import { createLogger } from "../../utils/logger";

const log = createLogger("matrix-bridge");

/** The image types `avatar.ts` accepts, by extension. Anything else is declined there. */
function contentTypeFor(path: string): string {
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

export interface MatrixBridgeConfig {
  enabled: boolean;
  homeserverUrl: string;
  domain: string;
  asToken: string;
  hsToken: string;
}

/** What the deployment says. Read once, at boot, like every other switch here. */
/**
 * Who a room's live stream is for: the Matrix id of the person the station
 * belongs to.
 *
 * A turn's text is pushed to that person's own devices while it is being
 * written (see `live.ts`), so this answers "whose devices". `null` — a room
 * whose owner has no principal, or a principal with no Matrix identity mapped —
 * simply means no live view; the room still gets its message.
 *
 * Two lookups rather than one join, because `stations.userId` is a Better Auth
 * id and `principal_identities.principal_id` is a `prn_…` value now — joining
 * them directly would silently match nothing for every station. Still looked
 * up once per attachment rather than per chunk: an agent can emit hundreds of
 * chunks in a turn.
 */
async function readerForRoom(roomId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: stations.userId })
    .from(matrixRooms)
    .innerJoin(stations, eq(stations.id, matrixRooms.stationId))
    .where(eq(matrixRooms.roomId, roomId));
  if (!row) return null;

  const principal = await principalForUser(row.userId);
  if (!principal) return null;

  const [identity] = await db
    .select({ externalId: principalIdentities.externalId })
    .from(principalIdentities)
    .where(
      and(
        eq(principalIdentities.principalId, principal.id),
        eq(principalIdentities.system, "matrix")
      )
    );
  return identity?.externalId ?? null;
}

export function matrixBridgeConfig(env = process.env): MatrixBridgeConfig {
  return {
    // The literal lowercase "true" — see the note above.
    enabled: env.ENABLE_MATRIX_BRIDGE === "true",
    homeserverUrl: env.MATRIX_HOMESERVER_URL ?? "http://127.0.0.1:6167",
    domain: env.MATRIX_SERVER_NAME ?? "id.agentpod.dev",
    asToken: env.MATRIX_AS_TOKEN ?? "",
    hsToken: env.MATRIX_HS_TOKEN ?? "",
  };
}

/**
 * What is missing before this bridge can work.
 *
 * Returned rather than thrown: a hub whose Matrix configuration is half-done
 * must still boot and serve its fleet. The warning is what an operator reads.
 */
export function matrixBridgeProblems(cfg: MatrixBridgeConfig): string[] {
  if (!cfg.enabled) return [];
  const missing: string[] = [];
  if (!cfg.asToken) missing.push("MATRIX_AS_TOKEN");
  if (!cfg.hsToken) missing.push("MATRIX_HS_TOKEN");
  return missing;
}

export interface MatrixBridge {
  client: MatrixClient;
  config: MatrixBridgeConfig;
  /** Everything provisioning needs, so boot and the API use the same deps. */
  provisionDeps: Parameters<typeof provisionAll>[0];
  /** Give a station its identity and room. Safe to call repeatedly. */
  provision(stationId: string): Promise<void>;
  /** Handle one event the homeserver pushed. */
  onEvent(event: { type: string; sender: string; room_id?: string; content?: Record<string, unknown> }): Promise<void>;
  /** Create the room behind an alias the homeserver asked about. */
  onProvisionAlias(alias: string): Promise<void>;
}

/**
 * Build the bridge, or null when it is switched off.
 *
 * Null rather than a no-op object so the caller cannot accidentally mount routes
 * that would answer a homeserver this deployment never agreed to talk to.
 */
export function createMatrixBridge(cfg = matrixBridgeConfig()): MatrixBridge | null {
  if (!cfg.enabled) return null;

  const problems = matrixBridgeProblems(cfg);
  if (problems.length > 0) {
    log.warn("matrix bridge is enabled but not configured; it will not run", {
      missing: problems,
    });
    return null;
  }

  const client = createMatrixClient({
    homeserverUrl: cfg.homeserverUrl,
    asToken: cfg.asToken,
    domain: cfg.domain,
  });

  /**
   * Read a file from a station's workspace, through its node.
   *
   * Used for one thing — an agent's avatar — so it is deliberately small: a
   * short timeout, a size cap, and null for everything that is not a plain
   * successful read. The image lives on whichever machine the station does, and
   * that machine may be offline, busy, or simply not have the file.
   */
  const readWorkspaceFile = async (
    stationId: string,
    path: string
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> => {
    const [station] = await db
      .select({ nodeId: stations.nodeId, stationKey: stations.stationKey })
      .from(stations)
      .where(eq(stations.id, stationId));
    if (!station) return null;

    const res = await broker.request(
      station.nodeId,
      "fs.read",
      { key: station.stationKey, path, maxBytes: 2 * 1024 * 1024 },
      { timeoutMs: 5_000 }
    );
    if (!res.ok) return null;

    const data = res.data as { content?: string; encoding?: string; truncated?: boolean };
    // A truncated image is a corrupt image. Better no face than a broken one.
    if (!data?.content || data.encoding !== "base64" || data.truncated) return null;

    return {
      bytes: Uint8Array.from(Buffer.from(data.content, "base64")),
      contentType: contentTypeFor(path),
    };
  };

  const provisionDeps = { domain: cfg.domain, client, readWorkspaceFile };

  /**
   * Answering a gate, wired only when a board is configured.
   *
   * `KAAMBAAN_BASE_URL` absent means no board, which means no gate could have
   * been projected in the first place — so leaving this undefined is the
   * honest state rather than a half-built path that fails at the last step.
   */
  const kaambaanBaseUrl = (process.env.KAAMBAAN_BASE_URL ?? "").trim();
  const gates = kaambaanBaseUrl
    ? {
        handle: (
          event: { sender: string; content: Record<string, unknown> },
          roomId: string
        ) =>
          handleGateDecision(event, roomId, {
            // The subject comes from here and from nowhere else. This is the
            // control that makes minting an assertion for another principal
            // safe to have at all — see `mintPrincipalAssertion`.
            principalForMatrixId: async (mxid: string) => {
              const identity = await resolveMatrixId(mxid);
              return identity?.kind === "principal" ? identity.principalId : null;
            },
            projectionFor: projectionForGate,
            resolveGate: (input) =>
              resolveGateAtKaambaan(input, {
                baseUrl: kaambaanBaseUrl,
                mint: (principalId) => mintPrincipalAssertion({ principalId }),
              }),
            reply: async (roomId: string, body: string) => {
              const room = await roomAgentUser(roomId, cfg.domain);
              return room ? client.sendText(room, roomId, body) : null;
            },
          }),
      }
    : undefined;

  const inboundDeps = {
    domain: cfg.domain,
    gates,
    client,
    acp: {
      createSession: async (input: { stationId: string; userId: string; mode: string }) => {
        const session = await createSession({
          stationId: input.stationId,
          userId: input.userId,
          mode: input.mode as never,
        });
        return { id: session.id };
      },
      promptSession,
      answerPermission,
    },
    // The joint between inbound and outbound. Without it a session is created,
    // prompted, and answers into a stream nobody is listening to — which is
    // exactly what happened the first time this ran against the real fleet.
    attach: (sessionId: string, roomId: string, agentUser: string) =>
      attachRoomToSession(sessionId, roomId, agentUser, {
        client,
        readerFor: readerForRoom,
      }),
    noteTrigger: noteTurnTrigger,
  };

  return {
    client,
    config: cfg,
    provisionDeps,

    async provision(stationId: string) {
      await provisionStation(stationId, provisionDeps);
    },

    async onEvent(event) {
      await handleRoomMessage(event, inboundDeps);
    },

    async onProvisionAlias(alias: string) {
      // The homeserver asks about an alias when somebody tried to resolve it.
      // Answering yes without creating the room would send them somewhere that
      // is not there.
      //
      // Two shapes to try — fix round 3 on Task 5: an occupied station's
      // room alias is occupant-derived now (`bridgeAliasForHandle`), and a
      // station with no occupant still uses the station-derived form
      // (`bridgeAlias`). Occupant-derived is tried first since it is the
      // ordinary case for any station with someone in it; station-derived
      // is what a room with no occupant, or one this migration hasn't
      // reached, still resolves through.
      const { stationForLocalpart, stationForOccupantLocalpart, localpartFromAlias } = await import(
        "./stations"
      );
      const localpart = localpartFromAlias(alias, cfg.domain);
      const station = localpart
        ? (await stationForOccupantLocalpart(localpart)) ?? (await stationForLocalpart(localpart))
        : null;
      if (station) await provisionStation(station.stationId, provisionDeps);
    },
  };
}

/**
 * Provision every station at boot, and stream any session already running.
 *
 * Runs after the routes are mounted, so a homeserver that starts pushing
 * immediately finds somewhere to push to.
 */
export async function startMatrixBridge(bridge: MatrixBridge): Promise<void> {
  const result = await provisionAll(bridge.provisionDeps);
  log.info("matrix bridge ready", {
    domain: bridge.config.domain,
    provisioned: result.provisioned,
    failed: result.failed,
  });
}

export { attachRoomToSession };
