<script lang="ts">
  /**
   * RoleDialog.svelte
   *
   * Shared role-change dialog, extracted from the previously duplicated
   * (verbatim) role dialogs on the admin users list and user-detail pages.
   *
   * HARD CONSTRAINT: imports ONLY `updateUserRole` from $lib/api/admin —
   * mirrors the user-detail page's test mock set (getUser/banUser/
   * unbanUser/updateUserRole); this component must not reach for anything
   * beyond that set.
   */
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import { toast } from "svelte-sonner";
  import { updateUserRole } from "$lib/api/admin";
  import type { UserRole } from "@agentpod/types";

  interface RoleTargetUser {
    id: string;
    email: string;
    role: UserRole;
  }

  interface Props {
    open: boolean;
    user: RoleTargetUser | null;
    onChanged: () => void;
  }

  let { open = $bindable(false), user, onChanged }: Props = $props();

  const roleLabel: Record<UserRole, string> = {
    user: "User",
    admin: "Admin",
  };

  let newRole = $state<UserRole>("user");
  let isUpdating = $state(false);

  // Seed the selected role from the target user each time the dialog opens
  $effect(() => {
    if (open) newRole = user?.role ?? "user";
  });

  function handleOpenChange(isOpen: boolean) {
    open = isOpen;
  }

  async function handleConfirm() {
    if (!user || newRole === user.role || isUpdating) return;

    isUpdating = true;
    try {
      await updateUserRole(user.id, newRole);
      toast.success(`${user.email} is now ${newRole}`);
      open = false;
      onChanged();
    } catch (e) {
      const err = e as Error;
      toast.error("Failed to update role", { description: err.message });
    } finally {
      isUpdating = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content showCloseButton={false}>
      <Dialog.Header>
        <Dialog.Title>Change role</Dialog.Title>
        <Dialog.Description>Change role for {user?.email}</Dialog.Description>
      </Dialog.Header>

      <div class="space-y-2 py-2">
        <Label for="role-select">New role</Label>
        <Select.Root
          type="single"
          value={newRole}
          onValueChange={(v) => {
            if (v) newRole = v as UserRole;
          }}
        >
          <Select.Trigger class="w-full" id="role-select">
            {roleLabel[newRole]}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="user">User</Select.Item>
            <Select.Item value="admin">Admin</Select.Item>
          </Select.Content>
        </Select.Root>
        {#if newRole === "admin"}
          <p class="text-xs text-destructive">
            Admins have full access to manage all users and system settings.
          </p>
        {/if}
      </div>

      <Dialog.Footer>
        <Button variant="outline" onclick={() => (open = false)} disabled={isUpdating}>
          Cancel
        </Button>
        <Button onclick={handleConfirm} disabled={isUpdating || newRole === user?.role}>
          {isUpdating ? "Changing…" : "Change role"}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
