<script lang="ts">
  /**
   * BanUserDialog.svelte
   *
   * Shared ban-user confirmation dialog, extracted from the previously
   * duplicated ban dialogs on the admin users list and user-detail pages.
   * Fixes the detail page's missing Label/Textarea `for`/`id` wiring (the
   * list page had it right; the detail page's Label had no `for` at all).
   *
   * HARD CONSTRAINT: imports ONLY `banUser` from $lib/api/admin — the
   * user-detail page's test mocks exactly getUser/banUser/unbanUser/
   * updateUserRole, so this component (which the detail page renders) must
   * not reach for anything beyond that set.
   */
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { toast } from "svelte-sonner";
  import { banUser } from "$lib/api/admin";

  interface BanTargetUser {
    id: string;
    name?: string | null;
    email: string;
  }

  interface Props {
    open: boolean;
    user: BanTargetUser | null;
    onBanned: () => void;
  }

  let { open = $bindable(false), user, onBanned }: Props = $props();

  let reason = $state("");
  let isBanning = $state(false);

  // Reset the reason each time the dialog opens (new user, clean slate)
  $effect(() => {
    if (open) reason = "";
  });

  function handleOpenChange(isOpen: boolean) {
    open = isOpen;
  }

  async function handleConfirm() {
    if (!user || !reason.trim() || isBanning) return;

    isBanning = true;
    try {
      await banUser(user.id, reason.trim());
      toast.success(`${user.email} has been banned`);
      open = false;
      reason = "";
      onBanned();
    } catch (e) {
      const err = e as Error;
      toast.error("Failed to ban user", { description: err.message });
    } finally {
      isBanning = false;
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content showCloseButton={false}>
      <Dialog.Header>
        <Dialog.Title>Ban user</Dialog.Title>
        <Dialog.Description>
          Ban {user?.email}? They will be logged out and unable to access the platform.
        </Dialog.Description>
      </Dialog.Header>

      <div class="space-y-2 py-2">
        <Label for="ban-reason">Reason (required)</Label>
        <Textarea
          id="ban-reason"
          bind:value={reason}
          placeholder="Enter the reason for banning this user..."
          disabled={isBanning}
          class="w-full"
        />
      </div>

      <Dialog.Footer>
        <Button variant="outline" onclick={() => (open = false)} disabled={isBanning}>
          Cancel
        </Button>
        <Button variant="destructive" onclick={handleConfirm} disabled={isBanning || !reason.trim()}>
          {isBanning ? "Banning…" : "Ban user"}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
