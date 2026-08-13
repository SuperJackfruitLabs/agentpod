<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import { Field } from "$lib/components/ui/field";
  import { provisionRuntime, type DriverManifest } from "$lib/api/client";
  import type { RuntimeHarness } from "@agentpod/contract";

  // Select components report their value as `string | string[]`; every
  // Select.Root here uses type="single", so coerce back to a plain string
  // (falling back when the array is empty) in one place.
  const single = (v: string | string[], fallback: string) =>
    Array.isArray(v) ? (v[0] ?? fallback) : v;

  interface Props {
    open: boolean;
    providers: string[];
    /**
     * What each provider's driver declares about itself, straight from the
     * hub's registry. The form is built from these rather than from anything
     * hardcoded here: Cloudflare fixes instance_type at worker deploy time, so
     * a tier map baked into the UI would rot the moment a worker is redeployed
     * at a different instance type — and a provider this file has never heard
     * of must still get a usable form.
     */
    manifests?: DriverManifest[];
    onClose: () => void;
    onCreated?: () => void;
  }

  let { open, providers, manifests = [], onClose, onCreated }: Props = $props();

  // Fallback for a hub too old to report manifests. Only the tiers that every
  // driver in that era supported, so an unreported provider cannot be offered
  // a tier its driver will refuse.
  const FALLBACK_TIERS = ["small"];

  const harnessOptions = [
    { value: "none", label: "Generic" },
    { value: "opencode", label: "OpenCode" },
    { value: "pi", label: "Pi" },
  ];

  // provider/name/tier/harness are reset each time the dialog opens via $effect
  let provider = $state("");
  let name = $state("");
  let resourceTier = $state("small");
  let harness = $state("none");
  let isCreating = $state(false);
  let error = $state<string | null>(null);

  const manifest = $derived(manifests.find((m) => m.provider === provider));

  const harnessLabel = $derived(
    harnessOptions.find((h) => h.value === harness)?.label ?? "Generic",
  );

  // Only the tiers that can actually run what is being asked for.
  //
  // Two narrowings, and both were learned the hard way. The PROVIDER's:
  // Cloudflare fixes instance_type at worker deploy time, so offering it three
  // sizes produced a guaranteed backend error. The HARNESS's: Fly's `small` is
  // 1 GB and one OpenCode chat turn peaked at 855 MB of harness on top of the
  // OS and the node-agent — the whole machine — so the runtime provisioned,
  // mounted its volume, enrolled, answered once and then went unreachable
  // (#279). The user met that as "couldn't reach the hub", long after the
  // choice that caused it.
  //
  // `harnessTiers` is the hub's answer, not ours: it holds both the harness
  // requirements and each driver's real sizing, and it deploys separately from
  // this bundle. Falling back to `supportedTiers` keeps an older hub working —
  // its own refusal is then the backstop.
  const tiers = $derived<readonly string[]>(
    manifest?.harnessTiers?.[harness as RuntimeHarness] ??
      manifest?.supportedTiers ??
      FALLBACK_TIERS,
  );

  // A provider can legitimately have nothing that fits — a Cloudflare worker
  // deployed at a small instance type cannot run OpenCode at any size. Saying
  // so beats offering the only tier it has and failing after provisioning.
  const noViableTier = $derived(tiers.length === 0);

  // Reset all fields when the dialog opens so each session is clean
  $effect(() => {
    if (open) {
      name = "";
      error = null;
      harness = "none";
      provider = providers[0] ?? "docker";
    }
  });

  // Keep the selected tier valid: on open, whenever the provider changes to one
  // that does not offer the current selection, and whenever the HARNESS changes
  // to one the current selection is too small for. Without the last case the
  // form renders a narrowed list and still posts the tier it was showing
  // before — the same doomed request, with a tidier dialog around it.
  $effect(() => {
    if (tiers.length > 0 && !tiers.includes(resourceTier)) {
      resourceTier = tiers[0]!;
    }
  });

  function handleOpenChange(isOpen: boolean) {
    if (!isOpen) onClose();
  }

  async function handleCreate() {
    const trimmedName = name.trim();
    // noViableTier guards here as well as on the button: there is no tier to
    // send, so the request could only be a guess.
    if (!trimmedName || isCreating || noViableTier) return;
    isCreating = true;
    error = null;
    try {
      await provisionRuntime({ provider, name: trimmedName, resourceTier, harness });
      onCreated?.();
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to provision runtime";
    } finally {
      isCreating = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content showCloseButton={false}>
      <Dialog.Header>
        <Dialog.Title>New runtime</Dialog.Title>
        <Dialog.Description>Create a container that runs an agent for you.</Dialog.Description>
      </Dialog.Header>

      <div class="space-y-4 py-2">
        <!-- Provider select -->
        <Field label="Provider" for="runtime-provider">
          <Select.Root
            type="single"
            value={provider}
            onValueChange={(v: string | string[]) => {
              provider = single(v, "");
            }}
          >
            <Select.Trigger class="w-full" id="runtime-provider">
              {provider || "Select provider"}
            </Select.Trigger>
            <Select.Content>
              {#each providers as p (p)}
                <Select.Item value={p}>{p}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </Field>

        <!-- Name input -->
        <Field label="Name" for="runtime-name">
          <Input
            id="runtime-name"
            placeholder="Runtime name"
            bind:value={name}
            class="font-mono"
            disabled={isCreating}
          />
        </Field>

        <!-- Resource tier select -->
        <Field label="Resource tier" for="runtime-tier">
          <Select.Root
            type="single"
            value={resourceTier}
            onValueChange={(v: string | string[]) => {
              resourceTier = single(v, "small");
            }}
          >
            <Select.Trigger class="w-full" id="runtime-tier" disabled={noViableTier}>
              {noViableTier ? "—" : resourceTier || "Select tier"}
            </Select.Trigger>
            <Select.Content>
              {#each tiers as t (t)}
                <Select.Item value={t}>{t}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </Field>

        <!-- Harness select -->
        <Field label="Harness" for="runtime-harness">
          <Select.Root
            type="single"
            value={harness}
            onValueChange={(v: string | string[]) => {
              harness = single(v, "none");
            }}
          >
            <Select.Trigger class="w-full" id="runtime-harness">
              {harnessLabel}
            </Select.Trigger>
            <Select.Content>
              {#each harnessOptions as opt (opt.value)}
                <Select.Item value={opt.value}>{opt.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </Field>

        <!-- Nothing this provider offers is big enough for the chosen harness -->
        {#if noViableTier}
          <p class="text-sm font-mono text-destructive" role="alert">
            No {provider} tier can run {harnessLabel}. Pick another provider, or a harness
            that fits.
          </p>
        {/if}

        <!-- Inline error -->
        {#if error}
          <p class="text-sm font-mono text-destructive" role="alert">{error}</p>
        {/if}
      </div>

      <Dialog.Footer>
        <Button variant="outline" onclick={onClose} disabled={isCreating}>Cancel</Button>
        <Button
          onclick={handleCreate}
          disabled={!name.trim() || isCreating || noViableTier}
          class="font-mono"
        >
          {isCreating ? "Creating…" : "Create runtime"}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
