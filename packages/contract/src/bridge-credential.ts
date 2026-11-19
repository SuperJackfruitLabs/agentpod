import { z } from "zod";
import { PrincipalId, OrganizationId } from "./ids";

/** An exact `https://host[:port]` origin: no path, query, fragment or userinfo. */
const HttpsOrigin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}, "an https origin");

const fields = {
  version: z.literal(1),
  kind: z.literal("station-plane"),
  principalId: PrincipalId,
  organizationId: OrganizationId,
};

/**
 * An operator-selected exchange source, never a caller-supplied bearer token.
 *
 * This is the stored grammar only: `audience` is any exact https origin, so one row shape serves
 * every deployment. It never admits a source by itself. A hub admits and spends a source only
 * through `bridgeCredentialSourceFor(itsOwnAudience)`, a closed set of one.
 */
export const BridgeCredentialSource = z
  .object({ ...fields, audience: HttpsOrigin })
  .strict();
export type BridgeCredentialSource = z.infer<typeof BridgeCredentialSource>;

/**
 * The source grammar for one deployment: `audience` must be exactly that deployment's
 * SuperPipeline audience. Throws when the deployment audience itself is not an https origin, so a
 * misconfigured hub admits nothing rather than everything.
 */
export function bridgeCredentialSourceFor(deploymentAudience: string) {
  if (!HttpsOrigin.safeParse(deploymentAudience).success)
    throw new Error("The deployment SuperPipeline audience must be an https origin");
  return z
    .object({ ...fields, audience: z.literal(deploymentAudience) })
    .strict();
}
