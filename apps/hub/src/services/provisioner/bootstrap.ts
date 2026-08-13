/**
 * Provisioner bootstrap — registers the real RuntimeProvisioner driver
 * instances for every enabled provider, once at hub startup.
 *
 * Without this, `getProvisioner(provider)` finds no registered driver (only the
 * env flag is set) and `createRuntime` throws "provider not registered" → 400.
 * The integration tests register a fake provisioner explicitly, so this wiring
 * is the only place the production drivers get connected to the registry.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { provisionedRuntimes } from "../../db/schema/nodes";
import { registerProvisioner, isProviderEnabled } from "./registry";
import { DockerRuntimeProvisioner } from "./docker";
import { CloudflareSandboxProvisioner } from "./cloudflare-sandbox";
import { FlyMachinesProvisioner } from "./fly";
import { createActivityToucher } from "../runtime-activity";
import { setActivityHook } from "../broker";

export function registerEnabledProvisioners(): void {
  if (isProviderEnabled("docker")) {
    registerProvisioner(new DockerRuntimeProvisioner());
  }
  if (isProviderEnabled("cloudflare")) {
    const cloudflare = new CloudflareSandboxProvisioner();
    registerProvisioner(cloudflare);

    // Tell Cloudflare a station is in use whenever the hub routes a verb to it.
    // Its idle timer counts only incoming requests and a node-agent dials out,
    // so without this a station sleeps 15 minutes after start however busy it
    // is — which is exactly how a live station vanished mid-session on
    // 2026-08-12.
    const toucher = createActivityToucher({
      lookup: async (nodeId) => {
        const [row] = await db
          .select({
            provider: provisionedRuntimes.provider,
            externalId: provisionedRuntimes.externalId,
          })
          .from(provisionedRuntimes)
          .where(
            and(
              eq(provisionedRuntimes.nodeId, nodeId),
              eq(provisionedRuntimes.status, "online")
            )
          );
        if (!row?.externalId) return null;
        return { provider: row.provider, externalId: row.externalId };
      },
      touch: (externalId) => cloudflare.touch(externalId),
      now: () => Date.now(),
    });

    // Fire-and-forget: touch() never throws, and a renewal must never delay or
    // fail the user's actual verb.
    setActivityHook((nodeId) => void toucher.touch(nodeId));
  }

  if (isProviderEnabled("fly")) {
    // Constructing it resolves FLY_API_TOKEN through requireCredentials, which
    // throws if it is missing — a startup-time refusal to register, by design.
    // validate-config has already refused the boot with a better message by
    // this point, so this throw is the backstop rather than the front line.
    //
    // No activity toucher, unlike Cloudflare: a Fly machine with no `services`
    // block is never reaped for idleness, so there is no deadline to push out.
    registerProvisioner(new FlyMachinesProvisioner());
  }
}
