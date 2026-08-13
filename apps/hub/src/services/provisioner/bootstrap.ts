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
import { ModalRuntimeProvisioner } from "./modal";
import { createModalApi } from "./modal-api";
import type { CreateModalApiOptions } from "./modal-api";
import { FlyMachinesProvisioner } from "./fly";
import { createActivityToucher } from "../runtime-activity";
import { setActivityHook } from "../broker";

export interface BootstrapOptions {
  /**
   * Stand-in for `new ModalClient(...)`, forwarded to `createModalApi`.
   *
   * Exists so the wiring test can prove the Modal branch registers without
   * constructing the real SDK client — which is 0.x, falls back to reading an
   * operator's ~/.modal.toml, and has no business being built by a unit test.
   * The production path passes nothing and is unchanged: credential resolution,
   * and its refusal, happen either way.
   */
  modalClientFactory?: CreateModalApiOptions["clientFactory"];
}

export function registerEnabledProvisioners({
  modalClientFactory,
}: BootstrapOptions = {}): void {
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

  if (isProviderEnabled("modal")) {
    // The flag alone gates this: nothing is derived from the presence of
    // credentials, so pasting tokens into a hub's environment while evaluating
    // Modal cannot quietly start provisioning on it.
    //
    // createModalApi resolves MODAL_TOKEN_ID/MODAL_TOKEN_SECRET and throws
    // naming every one that is missing, so a half-configured deploy fails at
    // boot rather than on a user's first provisioning attempt. validateConfig()
    // runs earlier in src/index.ts and turns the same misconfiguration into a
    // message naming the variables; this throw is the backstop for anything
    // that reaches registration without it.
    //
    // No touch hook: Modal reaps nothing for idleness (idleTimeoutMs is opt-in
    // and we never opt in), so there is no deadline to push out.
    registerProvisioner(
      new ModalRuntimeProvisioner({
        api: createModalApi({ clientFactory: modalClientFactory }),
      })
    );
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
