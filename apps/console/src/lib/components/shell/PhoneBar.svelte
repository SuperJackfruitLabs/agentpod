<script lang="ts">
  /**
   * PhoneBar — the bottom bar under 900px: Fleet, Agents, Activity, More. More is the current
   * place for every section it holds (Nodes, Runtimes, Settings, Admin) and opens MoreSheet.
   */
  import { page } from "$app/state";
  import { phoneCurrent, phoneItems } from "./nav";
  import NavIcon from "./NavIcon.svelte";
  import MoreSheet from "./MoreSheet.svelte";

  let moreOpen = $state(false);
  const current = $derived(phoneCurrent(page.url.pathname));
  const items = phoneItems();
</script>

<nav data-testid="phone-bar" class="ap-phonebar" aria-label="Console, phone">
  {#each items as item (item.id)}
    <a
      href={item.href}
      class="ap-phonebar__item"
      aria-current={current === item.id ? "page" : undefined}
    ><NavIcon id={item.id} class="size-[22px]" />{item.label}</a>
  {/each}
  <button
    type="button"
    class="ap-phonebar__item"
    aria-haspopup="dialog"
    aria-expanded={moreOpen}
    aria-current={current === "more" ? "page" : undefined}
    onclick={() => (moreOpen = true)}
  ><NavIcon id="more" class="size-[22px]" />More</button>
</nav>

<MoreSheet bind:open={moreOpen} />
