/**
 * The push gateway, built from the environment — or null, which the route
 * answers with 404.
 */

import { readFileSync } from "node:fs";

import { createLogger } from "../../utils/logger";
import { ApnsTokenProvider, createApnsClient, createHttp2Transport } from "./apns";
import { pushConfigFromEnv } from "./config";
import { createPushGateway, type PushGateway } from "./gateway";

const log = createLogger("push-gateway");

export function createPushGatewayFromEnv(env: Record<string, string | undefined> = process.env): PushGateway | null {
  const result = pushConfigFromEnv(env);
  if (result.status === "off") return null;
  if (result.status === "invalid") {
    // Off rather than a refusal to boot: pushes are a convenience, and a typo in
    // them must not take the fleet's control plane down with it.
    log.error("push gateway is misconfigured and stays off", { problems: result.problems });
    return null;
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
    return null;
  }
  log.info("push gateway on", {
    topic: config.topic,
    appIds: [...config.appIds].map(([id, env]) => `${id}:${env}`),
  });
  return createPushGateway({
    apns: createApnsClient({ tokens, topic: config.topic, transport: createHttp2Transport() }),
    appIds: config.appIds,
  });
}
