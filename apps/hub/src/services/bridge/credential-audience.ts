/**
 * The one SuperPipeline audience a station-plane credential source may name on this hub.
 *
 * The audience is the deployment's own: the origin of `SUPERPIPELINE_BASE_URL`, the SuperPipeline
 * this hub's bridge already claims from. A staging hub therefore admits only the staging
 * audience and production only production's. It is never taken from the row, the request or the
 * checkpoint profile, so no caller can name another plane.
 */
import {
  bridgeCredentialSourceFor,
  type BridgeCredentialSource,
} from "../../../../../packages/contract/src/bridge-credential";

/** A roster refusal whose message is safe to return to the operator who caused it. */
export class BridgeRosterRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeRosterRefusal";
  }
}

/** The configured audience, or null when `SUPERPIPELINE_BASE_URL` is unset or not https. */
export function deploymentSuperpipelineAudience(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = (env.SUPERPIPELINE_BASE_URL ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Admit a source for this deployment, or throw a `BridgeRosterRefusal` that names what was
 * expected. The message carries no identifier from the source beyond the audience it refused.
 */
export function parseDeploymentCredentialSource(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): BridgeCredentialSource {
  const audience = deploymentSuperpipelineAudience(env);
  if (!audience)
    throw new BridgeRosterRefusal(
      "SUPERPIPELINE_BASE_URL is not an https origin, so this hub admits no station-plane credential source",
    );
  const parsed = bridgeCredentialSourceFor(audience).safeParse(raw);
  if (!parsed.success)
    throw new BridgeRosterRefusal(
      `A station-plane credential source must be version 1 with a prn_ principal, an org_ organization and this deployment's SuperPipeline audience, ${audience}`,
    );
  return parsed.data;
}
