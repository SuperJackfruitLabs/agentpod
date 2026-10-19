<script lang="ts">
  /**
   * AccountMenu — the account chip (initials and email) and its menu: who is signed in,
   * Appearance (expands the control in place) and Sign out. A disclosure rather than a
   * role="menu": the panel holds pressed buttons in fieldsets, which a menu may not contain.
   * Escape or a click outside closes it; Escape gives focus back to the chip. Escape is caught on
   * the window in the capture phase while open, wherever focus is, so it never reaches the roster's
   * window shortcut (which would leave a station page). Opening moves focus to the first item.
   */
  import { tick } from "svelte";
  import { auth } from "$lib/stores/auth.svelte";
  import AppearanceControl from "./AppearanceControl.svelte";
  import { signOut } from "./sign-out";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import LogOut from "@lucide/svelte/icons/log-out";
  import SunMoon from "@lucide/svelte/icons/sun-moon";

  let open = $state(false);
  let appearanceOpen = $state(false);
  let chip = $state<HTMLButtonElement | null>(null);
  let root = $state<HTMLElement | null>(null);

  const email = $derived(auth.email ?? "");

  function close(focusChip = false) {
    open = false;
    appearanceOpen = false;
    if (focusChip) void tick().then(() => chip?.focus());
  }

  function open_() {
    open = true;
    void tick().then(() => root?.querySelector<HTMLElement>(".ap-acct__item")?.focus());
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (open && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  }

  $effect(() => {
    window.addEventListener("keydown", onWindowKeydown, true);
    return () => window.removeEventListener("keydown", onWindowKeydown, true);
  });

  function onWindowPointerDown(e: PointerEvent) {
    if (open && root && !root.contains(e.target as Node)) close();
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="ap-acct" bind:this={root}>
  <button
    bind:this={chip}
    type="button"
    data-testid="account-chip"
    class="ap-acct__chip"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls="account-menu"
    aria-label="Signed in as {email || auth.initials}. Appearance and sign out"
    onclick={() => (open ? close() : open_())}
  >
    <span data-testid="user-avatar" class="ap-acct__ini" aria-hidden="true">{auth.initials}</span>
    <span class="ap-acct__email">{email}</span>
  </button>

  {#if open}
    <div
      id="account-menu"
      data-testid="account-menu"
      class="ap-acct__menu"
      role="dialog"
      aria-label="Account"
      tabindex="-1"
    >
      <p class="ap-acct__who">{email}</p>
      <button
        type="button"
        class="ap-acct__item"
        aria-expanded={appearanceOpen}
        onclick={() => (appearanceOpen = !appearanceOpen)}
      >
        <SunMoon class="size-4" aria-hidden="true" />Appearance
        <ChevronDown class="ap-acct__chev size-4" aria-hidden="true" />
      </button>
      {#if appearanceOpen}
        <div class="ap-acct__appear"><AppearanceControl idPrefix="menu-appearance" /></div>
      {/if}
      <div class="ap-acct__foot">
        <button type="button" class="ap-acct__item" onclick={() => void signOut()}>
          <LogOut class="size-4" aria-hidden="true" />Sign out
        </button>
      </div>
    </div>
  {/if}
</div>
