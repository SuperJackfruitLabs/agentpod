<script lang="ts">
  /**
   * Navigation — the console's one persistent navigation. One markup, three looks chosen by the
   * vibe in shell.css: a top row (Daylight, Paper), a black ink rail with labelled icons
   * (Studio), a plain list of links (Quiet). Hidden on a phone, where PhoneBar takes over.
   * The current section is marked by aria-current and, visually, by more than colour (weight,
   * an underline or a bar, a filled cell).
   */
  import { page } from "$app/state";
  import { auth } from "$lib/stores/auth.svelte";
  import { currentSection, navItems } from "./nav";
  import NavIcon from "./NavIcon.svelte";

  const isAdmin = $derived(auth.user?.role === "admin");
  const items = $derived(navItems(isAdmin));
  const current = $derived(currentSection(page.url.pathname));
</script>

<nav data-testid="navigation" class="ap-nav" aria-label="Console">
  <ul class="ap-nav__list">
    {#each items as item (item.id)}
      {#if item.id === "settings"}
        <li class="ap-nav__sep" aria-hidden="true"></li>
      {/if}
      <li>
        <a
          href={item.href}
          class="ap-nav__link"
          aria-current={current === item.id ? "page" : undefined}
        ><NavIcon id={item.id} class="ap-nav__icon" />{item.label}</a>
      </li>
    {/each}
  </ul>
</nav>
