/**
 * superdial calls: the names the hub shares with the other side of each contract, and the switch.
 *
 * Calls run in a separate process, superdial-agent (the `superdial` repository), which joins a
 * call as the agent's `SUPERDIAL` device. The hub notices a person's call, mints that device,
 * hands it over, and sends each spoken turn's reply to the call. The contracts are C3, C4 and C6
 * of the superdial master plan (treaty owns them); every name here is copied from there.
 *
 * Off unless both `SUPERDIAL_AGENT_URL` and `SUPERDIAL_AGENT_TOKEN` are set: with no
 * superdial-agent to hand a call to, a call membership is ignored and the membership check
 * answers `calls_disabled`.
 */

/** The legacy MatrixRTC membership state event; state key `_{user_id}_{device_id}_m.call`. */
export const CALL_MEMBER_TYPE = "org.matrix.msc3401.call.member";
/** The newer MatrixRTC types, allowed at power 0 alongside the legacy one. */
export const RTC_MEMBER_TYPE = "org.matrix.msc4143.rtc.member";
export const RTC_SLOT_TYPE = "org.matrix.msc4143.rtc.slot";

/** The agent's call device: one per bridge agent, minted by appservice login with this id. */
export const CALL_DEVICE_ID = "SUPERDIAL";

/** C3: the key on a person's `m.room.message` that marks it as spoken in a call. */
export const SPOKEN_KEY = "dev.superdial.spoken";

/** C6: what a spoken turn's prompt starts with. Exact. */
export const SPOKEN_PROMPT_PREFIX =
  "[Spoken in a call, transcribed. Answer briefly, in plain sentences without markdown.]";

/** The voice a call speaks in when the station's own cannot be read. */
export const DEFAULT_CALL_VOICE = "af_heart";

export interface SuperdialConfig {
  /** Where superdial-agent serves C6, e.g. `http://127.0.0.1:8790`. "" = calls off. */
  agentUrl: string;
  /** The bearer both directions of C6 carry. "" = calls off. */
  agentToken: string;
  /** The bearer SuperExchange presents to the membership check (C4). "" = every check is 401. */
  membershipToken: string;
  /** Whether calls are on: an agent to hand them to, and the secret to reach it with. */
  enabled: boolean;
}

/** What the deployment says. Read once, at boot. */
export function superdialConfig(env: Record<string, string | undefined> = process.env): SuperdialConfig {
  const agentUrl = (env.SUPERDIAL_AGENT_URL ?? "").trim().replace(/\/+$/, "");
  const agentToken = (env.SUPERDIAL_AGENT_TOKEN ?? "").trim();
  const membershipToken = (env.SUPERDIAL_MEMBERSHIP_TOKEN ?? "").trim();
  return { agentUrl, agentToken, membershipToken, enabled: agentUrl !== "" && agentToken !== "" };
}
