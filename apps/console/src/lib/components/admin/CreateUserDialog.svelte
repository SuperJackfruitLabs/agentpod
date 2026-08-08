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
  import { Spinner } from "$lib/components/ui/spinner";
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
    // Put the cursor where the fix is needed.
    if (emailError) {
      document.getElementById("new-user-email")?.focus();
    } else if (passwordError) {
      document.getElementById("new-user-password")?.focus();
    }
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
      toast.success(`${email} added`);
      open = false;
      onCreated();
    } catch (e) {
      const err = e as Error;
      toast.error("Couldn't create user", { description: err.message });
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
        <Dialog.Description>Create an account directly, even when public signup is off.</Dialog.Description>
      </Dialog.Header>

      <!-- novalidate: our Field-level validation owns the errors (inline, focused)
           instead of the browser's native bubbles. -->
      <form
        novalidate
        onsubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        class="space-y-4 py-2"
      >
        <Field label="Name" for="new-user-name">
          <Input
            id="new-user-name"
            name="name"
            type="text"
            autocomplete="off"
            bind:value={name}
            required
            disabled={isCreating}
          />
        </Field>

        <Field label="Email" for="new-user-email" error={emailError ?? undefined}>
          <Input
            id="new-user-email"
            name="email"
            type="email"
            placeholder="user@example.com"
            autocomplete="off"
            spellcheck={false}
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
            name="new-password"
            type="password"
            placeholder="••••••••"
            autocomplete="new-password"
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
              Admins have full access to manage all users and system settings.
            </p>
          {/if}
        </Field>

        <!-- Footer lives INSIDE the form so Enter in any field submits natively. -->
        <Dialog.Footer>
          <Button
            type="button"
            variant="outline"
            onclick={() => (open = false)}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isCreating || !name.trim() || !email.trim() || !password}
          >
            {#if isCreating}<Spinner size="sm" class="text-primary-foreground" />{/if}
            {isCreating ? "Creating…" : "Create user"}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
