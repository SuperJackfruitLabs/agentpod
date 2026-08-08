<script lang="ts">
  /**
   * CreateUserDialog.svelte
   *
   * Shared create-user dialog, extracted from the admin users list page's
   * inline create-user form. List-page-only, so importing `createUser` from
   * $lib/api/admin is fine (unlike Ban/RoleDialog, which the user-detail
   * page also renders and must not import beyond its test mock's set).
   *
   * New vs. the original inline form: client-side validation (email format,
   * password minlength 8) surfaced via Field `error`, rather than relying
   * solely on native `required`/`minlength` browser validation.
   */
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import { Field } from "$lib/components/ui/field";
  import { toast } from "svelte-sonner";
  import { createUser } from "$lib/api/admin";
  import type { UserRole } from "@agentpod/types";

  interface Props {
    open: boolean;
    onCreated: () => void;
  }

  let { open = $bindable(false), onCreated }: Props = $props();

  const roleLabel: Record<UserRole, string> = {
    user: "User",
    admin: "Admin",
  };

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  let name = $state("");
  let email = $state("");
  let password = $state("");
  let role = $state<UserRole>("user");
  let isCreating = $state(false);
  let emailError = $state<string | null>(null);
  let passwordError = $state<string | null>(null);

  // Reset the form each time the dialog opens
  $effect(() => {
    if (open) {
      name = "";
      email = "";
      password = "";
      role = "user";
      emailError = null;
      passwordError = null;
    }
  });

  function handleOpenChange(isOpen: boolean) {
    open = isOpen;
  }

  function validate(): boolean {
    emailError = EMAIL_RE.test(email.trim()) ? null : "Enter a valid email address";
    passwordError = password.length >= 8 ? null : "Password must be at least 8 characters";
    return !emailError && !passwordError;
  }

  async function handleSubmit() {
    if (!name.trim() || !email.trim() || !password || isCreating) return;
    if (!validate()) return;

    isCreating = true;
    try {
      await createUser({
        email: email.trim(),
        password,
        name: name.trim(),
        role,
      });
      toast.success(`User ${email} created successfully`);
      open = false;
      onCreated();
    } catch (e) {
      const err = e as Error;
      toast.error("Failed to create user", { description: err.message });
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
        <Dialog.Title>Create user</Dialog.Title>
        <Dialog.Description>Create a new user account (bypasses signup restrictions)</Dialog.Description>
      </Dialog.Header>

      <form
        onsubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        class="space-y-4 py-2"
      >
        <Field label="Name" for="new-user-name">
          <Input
            id="new-user-name"
            type="text"
            placeholder="John Doe"
            bind:value={name}
            required
            disabled={isCreating}
          />
        </Field>

        <Field label="Email" for="new-user-email" error={emailError ?? undefined}>
          <Input
            id="new-user-email"
            type="email"
            placeholder="user@example.com"
            bind:value={email}
            required
            disabled={isCreating}
          />
        </Field>

        <Field
          label="Password"
          for="new-user-password"
          description={passwordError ? undefined : "Minimum 8 characters"}
          error={passwordError ?? undefined}
        >
          <Input
            id="new-user-password"
            type="password"
            placeholder="••••••••"
            bind:value={password}
            required
            minlength={8}
            disabled={isCreating}
          />
        </Field>

        <Field label="Role" for="new-user-role">
          <Select.Root
            type="single"
            value={role}
            onValueChange={(v) => {
              if (v) role = v as UserRole;
            }}
          >
            <Select.Trigger class="w-full" id="new-user-role">
              {roleLabel[role]}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="user">User</Select.Item>
              <Select.Item value="admin">Admin</Select.Item>
            </Select.Content>
          </Select.Root>
          {#if role === "admin"}
            <p class="text-xs text-destructive">
              Warning: Admins have full access to manage all users and system settings.
            </p>
          {/if}
        </Field>
      </form>

      <Dialog.Footer>
        <Button variant="outline" onclick={() => (open = false)} disabled={isCreating}>
          Cancel
        </Button>
        <Button
          onclick={handleSubmit}
          disabled={isCreating || !name.trim() || !email.trim() || !password}
        >
          {isCreating ? "Creating…" : "Create user"}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
