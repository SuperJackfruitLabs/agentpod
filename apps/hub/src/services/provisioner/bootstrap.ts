/**
 * Provisioner bootstrap — registers the real RuntimeProvisioner driver
 * instances for every enabled provider, once at hub startup.
 *
 * Without this, `getProvisioner(provider)` finds no registered driver (only the
 * env flag is set) and `createRuntime` throws "provider not registered" → 400.
 * The integration tests register a fake provisioner explicitly, so this wiring
 * is the only place the production drivers get connected to the registry.
 */
import { registerProvisioner, isProviderEnabled } from "./registry";
import { DockerRuntimeProvisioner } from "./docker";
import { CloudflareSandboxProvisioner } from "./cloudflare-sandbox";

export function registerEnabledProvisioners(): void {
  if (isProviderEnabled("docker")) {
    registerProvisioner(new DockerRuntimeProvisioner());
  }
  if (isProviderEnabled("cloudflare")) {
    registerProvisioner(new CloudflareSandboxProvisioner());
  }
}
