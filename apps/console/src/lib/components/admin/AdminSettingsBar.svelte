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
  import PlusIcon from "@lucide/svelte/icons/plus";

  interface Props {
    signupEnabled: boolean;
    onToggle: () => void;
    onCreateUser: () => void;
  }

  let { signupEnabled, onToggle, onCreateUser }: Props = $props();
</script>

<div class="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4">
  <!-- Signup toggle -->
  <div class="flex items-center gap-3">
    <span class="text-xs text-muted-foreground">Public signup</span>
    <Switch checked={signupEnabled} onCheckedChange={onToggle} />
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
