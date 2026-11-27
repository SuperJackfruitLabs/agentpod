/**
 * The agent's call device: a second Matrix device of a bridge agent, `SUPERDIAL`, which
 * superdial-agent joins calls as.
 *
 * Minted by appservice login, like the hub's own crypto device (`createDeviceProvisioner` in
 * `crypto-transport.ts`), but with a fixed `device_id` and a kept token:
 *
 * - **Appservice login logs nothing out.** The hub's own device and its keys are untouched; the
 *   agent simply has two devices. (`rotateCredentials` is the call that logs out first; it is not
 *   used here.)
 * - **Minted once and reused.** Logging in again with the same device id replaces that device's
 *   token, which would cut off a superdial-agent already holding the old one mid-call.
 * - **The token is the only Matrix credential superdial-agent gets.** It never sees the
 *   appservice token. Stored encrypted with ENCRYPTION_KEY, as the hub's other secrets are.
 *
 * Nothing here touches the hub's own device record (`<store>/<localpart>/device`), and
 * `feedAgents` reads only that device's key counts, so the hub's crypto never mistakes
 * `SUPERDIAL` for its own.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { superdialCallDevices } from "../../db/schema/superdial";
import { decrypt, encrypt } from "../../utils/encryption";
import { createLogger } from "../../utils/logger";
import { CALL_DEVICE_ID } from "./call-config";
import { isRecord } from "./outbound-payloads";

const log = createLogger("matrix-calls");

export interface CallDevice {
  deviceId: string;
  accessToken: string;
}

export interface CallDeviceStore {
  get(agentUserId: string): Promise<CallDevice | null>;
  put(agentUserId: string, device: CallDevice): Promise<void>;
}

/** The table, with the token encrypted at rest. */
export const dbCallDeviceStore: CallDeviceStore = {
  async get(agentUserId) {
    const [row] = await db
      .select()
      .from(superdialCallDevices)
      .where(eq(superdialCallDevices.agentUserId, agentUserId))
      .limit(1);
    if (!row) return null;
    return { deviceId: row.deviceId, accessToken: await decrypt(row.accessTokenEncrypted) };
  },
  async put(agentUserId, device) {
    const accessTokenEncrypted = await encrypt(device.accessToken);
    await db
      .insert(superdialCallDevices)
      .values({ agentUserId, deviceId: device.deviceId, accessTokenEncrypted })
      .onConflictDoUpdate({
        target: superdialCallDevices.agentUserId,
        set: { deviceId: device.deviceId, accessTokenEncrypted },
      });
  },
};

export function createCallDeviceProvisioner(deps: {
  homeserverUrl: string;
  asToken: string;
  store?: CallDeviceStore;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const store = deps.store ?? dbCallDeviceStore;
  const doFetch = deps.fetch ?? fetch;
  const cache = new Map<string, Promise<CallDevice>>();

  async function mint(agentUserId: string): Promise<CallDevice> {
    const kept = await store.get(agentUserId);
    if (kept) return kept;

    const localpart = agentUserId.slice(1).split(":")[0] ?? agentUserId;
    const res = await doFetch(new URL("/_matrix/client/v3/login", deps.homeserverUrl).toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.asToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "m.login.application_service",
        identifier: { type: "m.id.user", user: localpart },
        device_id: CALL_DEVICE_ID,
        initial_device_display_name: "superdial call",
      }),
    });
    const answer: unknown = await res.json().catch(() => ({}));
    const field = (key: string): string | undefined => {
      const v = isRecord(answer) ? answer[key] : undefined;
      return typeof v === "string" ? v : undefined;
    };
    const body = { device_id: field("device_id"), access_token: field("access_token"), errcode: field("errcode") };
    if (!res.ok) {
      throw new Error(`could not mint a call device for ${agentUserId}: ${res.status} ${body.errcode ?? ""}`.trim());
    }
    // A homeserver that ignored the requested id would hand out a third device every time.
    if (body.device_id !== CALL_DEVICE_ID || !body.access_token) {
      throw new Error(
        `could not mint a call device for ${agentUserId}: the login answered device ${String(body.device_id)}` +
          (body.access_token ? "" : " with no access token"),
      );
    }
    const device = { deviceId: CALL_DEVICE_ID, accessToken: body.access_token };
    await store.put(agentUserId, device);
    // Never the token.
    log.info("agent call device created", { agentUserId, deviceId: CALL_DEVICE_ID });
    return device;
  }

  return function callDeviceFor(agentUserId: string): Promise<CallDevice> {
    const existing = cache.get(agentUserId);
    if (existing) return existing;
    const resolved = mint(agentUserId);
    cache.set(agentUserId, resolved);
    // A failure is not the answer forever: the next call tries again.
    void resolved.catch(() => cache.delete(agentUserId));
    return resolved;
  };
}
