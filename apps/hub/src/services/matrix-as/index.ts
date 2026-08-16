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

import { createMatrixClient, type MatrixClient } from "./client";
import { provisionStation, provisionAll } from "./provision";
import { handleRoomMessage } from "./inbound";
import { attachRoomToSession } from "./outbound";
import { createSession, promptSession } from "../acp-sessions";
import { createLogger } from "../../utils/logger";

const log = createLogger("matrix-bridge");

export interface MatrixBridgeConfig {
  enabled: boolean;
  homeserverUrl: string;
  domain: string;
  asToken: string;
  hsToken: string;
}

/** What the deployment says. Read once, at boot, like every other switch here. */
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

  const provisionDeps = { domain: cfg.domain, client };

  const inboundDeps = {
    domain: cfg.domain,
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
    },
    // The joint between inbound and outbound. Without it a session is created,
    // prompted, and answers into a stream nobody is listening to — which is
    // exactly what happened the first time this ran against the real fleet.
    attach: (sessionId: string, roomId: string, agentUser: string) =>
      attachRoomToSession(sessionId, roomId, agentUser, { client }),
  };

  return {
    client,
    config: cfg,

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
      const { stationForLocalpart, localpartFromAlias } = await import("./stations");
      const localpart = localpartFromAlias(alias, cfg.domain);
      const station = localpart ? await stationForLocalpart(localpart) : null;
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
  const result = await provisionAll({ domain: bridge.config.domain, client: bridge.client });
  log.info("matrix bridge ready", {
    domain: bridge.config.domain,
    provisioned: result.provisioned,
    failed: result.failed,
  });
}

export { attachRoomToSession };
