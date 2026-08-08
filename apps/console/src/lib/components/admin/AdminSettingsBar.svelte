<script lang="ts">
  /**
   * AdminSettingsBar.svelte
   *
   * Public-signup toggle + create-user entry point for the admin users
   * page, extracted from the page's inline settings bar. Replaces the
   * hand-rolled ToggleLeft/ToggleRight icon button with the `Switch`
   * primitive.
   */
  import { Switch } from "$lib/components/ui/switch";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import PlusIcon from "@lucide/svelte/icons/plus";

  interface Props {
    signupEnabled: boolean;
    onToggle: () => void;
    onCreateUser: () => void;
    /** Disables the Switch while enable/disableSignup is in flight —
     * guards against a double-fire race on rapid re-clicks. */
    signupLoading?: boolean;
  }

  let { signupEnabled, onToggle, onCreateUser, signupLoading = false }: Props = $props();
</script>

<div class="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4">
  <!-- Signup toggle -->
  <div class="flex items-center gap-3">
    <Label for="signup-switch" class="text-xs font-normal text-muted-foreground">Public signup</Label>
    <Switch id="signup-switch" checked={signupEnabled} onCheckedChange={onToggle} disabled={signupLoading} />
    <span class="text-xs text-muted-foreground">
      {signupEnabled ? "Anyone can register" : "Admin invitation only"}
    </span>
  </div>

  <!-- Create user -->
  <Button onclick={onCreateUser}>
    <PlusIcon class="h-4 w-4 mr-2" />
    Create user
  </Button>
</div>
