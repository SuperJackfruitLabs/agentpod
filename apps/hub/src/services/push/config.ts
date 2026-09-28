/**
 * The push gateway's settings, read from the environment.
 *
 * All five variables or none: a gateway that could sign but not route, or route
 * but not sign, would accept pushes and lose them. With any missing the gateway
 * is off and `POST /_matrix/push/v1/notify` answers 404 — the same answer an
 * unconfigured Matrix bridge gives a homeserver.
 */

export type ApnsEnvironment = "production" | "sandbox";

export interface PushConfig {
  /** The `.p8` signing key, read from disk at boot — never logged. */
  keyPath: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id. One topic for both environments. */
  topic: string;
  /** Pusher `app_id` → which APNs environment its tokens belong to. */
  appIds: ReadonlyMap<string, ApnsEnvironment>;
}

export type PushConfigResult =
  | { status: "off" }
  | { status: "invalid"; problems: string[] }
  | { status: "on"; config: PushConfig };

const VARS = ["APNS_KEY_PATH", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_TOPIC", "PUSH_APP_IDS"] as const;

/**
 * `dev.supermessage.ios:production,dev.supermessage.ios.dev:sandbox`.
 * Returns the map, or the entries it could not read.
 */
export function parseAppIds(raw: string): { appIds: Map<string, ApnsEnvironment>; problems: string[] } {
  const appIds = new Map<string, ApnsEnvironment>();
  const problems: string[] = [];
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const at = entry.lastIndexOf(":");
    const appId = at > 0 ? entry.slice(0, at).trim() : "";
    const env = at > 0 ? entry.slice(at + 1).trim() : "";
    if (!appId || (env !== "production" && env !== "sandbox")) {
      problems.push(`PUSH_APP_IDS entry "${entry}" is not <app_id>:production|sandbox`);
      continue;
    }
    appIds.set(appId, env);
  }
  if (appIds.size === 0 && problems.length === 0) problems.push("PUSH_APP_IDS names no app ids");
  return { appIds, problems };
}

export function pushConfigFromEnv(env: Record<string, string | undefined> = process.env): PushConfigResult {
  const values = Object.fromEntries(VARS.map((k) => [k, env[k]?.trim() ?? ""])) as Record<(typeof VARS)[number], string>;
  const missing = VARS.filter((k) => values[k] === "");
  if (missing.length === VARS.length) return { status: "off" };
  if (missing.length > 0) {
    return { status: "invalid", problems: missing.map((k) => `${k} is not set`) };
  }
  const { appIds, problems } = parseAppIds(values.PUSH_APP_IDS);
  if (problems.length > 0) return { status: "invalid", problems };
  return {
    status: "on",
    config: {
      keyPath: values.APNS_KEY_PATH,
      keyId: values.APNS_KEY_ID,
      teamId: values.APNS_TEAM_ID,
      topic: values.APNS_TOPIC,
      appIds,
    },
  };
}
