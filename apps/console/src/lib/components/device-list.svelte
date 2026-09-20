<script lang="ts">
  /**
   * The machines that may act as you, and the button that stops one.
   *
   * `charter → decisions/2026-09-18-a-human-at-a-terminal-has-nothing-to-exchange.md`,
   * accepted 2026-09-20. A person at a terminal holds a 90-day device credential
   * rather than signing in through a browser every five minutes. The record's
   * condition for conceding that second long-lived secret was that devices become
   * "a thing an operator can see and name in a list" — this is that list.
   *
   * **`fleet devices` already prints one, and this exists anyway.** A list only a
   * CLI can print is not a revocation surface for the person whose laptop was
   * stolen, because they are not at that laptop. That is the whole argument for
   * the screen, and it is why this was a named task rather than something to add
   * later: a capability that shipped on the server with no way to reach it from
   * the product is exactly what happened to superpipeline's sign-in button earlier
   * on the same day.
   */
  import { listDevices, revokeDevice, deviceState, lastUsedLabel, type DeviceCredential } from "$lib/api/devices";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";

  let devices = $state<DeviceCredential[] | null>(null);
  let error = $state<string | null>(null);
  let revoking = $state<string | null>(null);

  async function load(): Promise<void> {
    try {
      devices = await listDevices();
      error = null;
    } catch (e) {
      // A hub that predates the endpoint answers 404, which is not a fault to
      // shout about — it is a hub that has not deployed this yet.
      devices = [];
      error = e instanceof Error ? e.message : "Could not read your devices.";
    }
  }

  $effect(() => {
    void load();
  });

  /**
   * Revoking is irreversible, so it asks — and names the machine, because the
   * whole risk on this screen is revoking the one you are holding rather than
   * the one you lost.
   */
  async function revoke(d: DeviceCredential): Promise<void> {
    if (!confirm(`Revoke "${d.name}"?\n\nThat machine will have to sign in through a browser again. This cannot be undone.`)) {
      return;
    }
    revoking = d.id;
    try {
      await revokeDevice(d.id);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : `Could not revoke ${d.name}.`;
    } finally {
      revoking = null;
    }
  }
</script>

<div class="space-y-4">
  <div class="space-y-1">
    <h2 class="t-section">Devices</h2>
    <p class="text-xs text-muted-foreground">
      Machines signed in with <code class="font-mono">fleet login</code>. Each holds a credential it
      exchanges for short-lived tokens, so it does not need a browser again for 90 days. Revoking one
      sends it back to the sign-in page.
    </p>
  </div>

  {#if devices === null}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if devices.length === 0}
    <p class="text-sm text-muted-foreground">
      No devices. Run <code class="font-mono">fleet login</code> on a machine to add one.
    </p>
  {:else}
    <ul class="divide-y rounded-lg border">
      {#each devices as d (d.id)}
        {@const state = deviceState(d)}
        <li class="flex flex-wrap items-center gap-3 p-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-medium">{d.name}</span>
              {#if state === "revoked"}
                <Badge variant="outline">revoked</Badge>
              {:else if state === "expired"}
                <Badge variant="outline">expired</Badge>
              {/if}
            </div>
            <p class="font-mono text-[11px] text-muted-foreground truncate">{d.id}</p>
          </div>

          <div class="text-xs text-muted-foreground whitespace-nowrap">
            {lastUsedLabel(d)}
          </div>

          {#if state === "active"}
            <Button variant="outline" size="sm" disabled={revoking === d.id} onclick={() => void revoke(d)}>
              {revoking === d.id ? "Revoking…" : "Revoke"}
            </Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if error}
    <p class="text-sm text-muted-foreground" role="alert">{error}</p>
  {/if}
</div>
