/**
 * The push services, built from the environment: the Matrix push gateway and
 * the fleet Live Activity, sharing one APNs client and one HTTP/2 connection.
 * Both null when APNS_* / PUSH_APP_IDS are not all set — the gateway route
 * then answers 404 and the Live Activity token route 503.
 */

import { readFileSync } from "node:fs";

import { createLogger } from "../../utils/logger";
import { ApnsTokenProvider, createApnsClient, createHttp2Transport, topicFor } from "./apns";
import { pushConfigFromEnv } from "./config";
import { createFleetService, type FleetService } from "./fleet/service";
import { dbLiveActivityTokenStore } from "./fleet/tokens";
import { createPushGateway, type PushGateway } from "./gateway";

const log = createLogger("push-gateway");

export interface PushServices {
  gateway: PushGateway | null;
  /** The fleet Live Activity (supermessage spec 2026-09-29, Part A). */
  fleet: FleetService | null;
}

export function createPushServicesFromEnv(env: Record<string, string | undefined> = process.env): PushServices {
  const off = { gateway: null, fleet: null };
  const result = pushConfigFromEnv(env);
  if (result.status === "off") return off;
  if (result.status === "invalid") {
    // Off rather than a refusal to boot: pushes are a convenience, and a typo in
    // them must not take the fleet's control plane down with it.
    log.error("push gateway is misconfigured and stays off", { problems: result.problems });
    return off;
  }
  const { config } = result;
  let keyPem: string;
  let tokens: ApnsTokenProvider;
  try {
    keyPem = readFileSync(config.keyPath, "utf8");
    tokens = new ApnsTokenProvider(keyPem, config.keyId, config.teamId);
  } catch (err) {
    log.error("push gateway cannot read its APNs key and stays off", {
      keyPath: config.keyPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return off;
  }
  log.info("push gateway on", {
    topic: config.topic,
    liveActivityTopic: topicFor(config.topic, "liveactivity"),
    appIds: [...config.appIds].map(([id, env]) => `${id}:${env}`),
  });
  // One client: the provider token and the HTTP/2 session are shared, which is
  // what Apple asks for and what keeps token re-signing inside its rate limit.
  const apns = createApnsClient({ tokens, topic: config.topic, transport: createHttp2Transport() });
  return {
    gateway: createPushGateway({ apns, appIds: config.appIds }),
    fleet: createFleetService({ apns, tokens: dbLiveActivityTokenStore }),
  };
}

/** The gateway alone. Kept for callers that need nothing else. */
export function createPushGatewayFromEnv(env: Record<string, string | undefined> = process.env): PushGateway | null {
  return createPushServicesFromEnv(env).gateway;
}
