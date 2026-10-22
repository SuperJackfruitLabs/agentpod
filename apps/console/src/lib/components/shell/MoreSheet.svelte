<script lang="ts">
  /**
   * MoreSheet — the phone's More: the sections the bottom bar has no room for, Appearance,
   * who is signed in, and Sign out. A bottom sheet on the console's Sheet (bits-ui dialog:
   * focus trap, Escape, overlay).
   */
  import * as Sheet from "$lib/components/ui/sheet";
  import { auth } from "$lib/stores/auth.svelte";
  import { moreItems } from "./nav";
  import NavIcon from "./NavIcon.svelte";
  import AppearanceControl from "./AppearanceControl.svelte";
  import { signOut } from "./sign-out";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import LogOut from "@lucide/svelte/icons/log-out";
  import SunMoon from "@lucide/svelte/icons/sun-moon";

  let { open = $bindable(false) }: { open?: boolean } = $props();
  let appearanceOpen = $state(false);

  const items = $derived(moreItems(auth));
</script>

<Sheet.Root bind:open onOpenChange={(o) => { if (!o) appearanceOpen = false; }}>
  <Sheet.Content side="bottom" data-testid="more-sheet" class="ap-more">
    <Sheet.Title class="ap-more__title">More</Sheet.Title>
    <Sheet.Description class="sr-only">Pages, appearance and your account</Sheet.Description>
    <nav aria-label="More pages">
      {#each items as item (item.id)}
        <a href={item.href} class="ap-more__item" onclick={() => (open = false)}>
          <NavIcon id={item.id} class="ap-more__icon size-5" />{item.label}
          <ChevronRight class="ap-more__chev size-4" aria-hidden="true" />
        </a>
      {/each}
    </nav>
    <div class="ap-more__sep" aria-hidden="true"></div>
    <button
      type="button"
      class="ap-more__item"
      aria-expanded={appearanceOpen}
      onclick={() => (appearanceOpen = !appearanceOpen)}
    >
      <SunMoon class="ap-more__icon size-5" aria-hidden="true" />Appearance
      <ChevronRight class="ap-more__chev size-4" aria-hidden="true" />
    </button>
    {#if appearanceOpen}
      <div class="ap-more__appear"><AppearanceControl idPrefix="more-appearance" /></div>
    {/if}
    <div class="ap-more__sep" aria-hidden="true"></div>
    <p class="ap-more__acct">
      <span class="ap-acct__ini" aria-hidden="true">{auth.initials}</span>{auth.email ?? ""}
    </p>
    <button type="button" class="ap-more__item" onclick={() => { open = false; void signOut(); }}>
      <LogOut class="ap-more__icon size-5" aria-hidden="true" />Sign out
    </button>
  </Sheet.Content>
</Sheet.Root>
