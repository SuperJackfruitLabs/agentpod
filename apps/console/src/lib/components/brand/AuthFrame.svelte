<script lang="ts">
  /**
   * The frame of the pages outside the shell (boot, sign-in, the sign-in callback): Daylight's sky
   * band behind the top of the page, the content over it (AP2-SignIn mockups). The other vibes draw
   * no sky; pages.css decides.
   */
  import type { Snippet } from "svelte";
  import { appearance } from "$lib/appearance.svelte";

  let { center = false, children }: { center?: boolean; children: Snippet } = $props();
</script>

<main class="ap-auth">
  {#if appearance.value.vibe === "daylight"}
    <div class="vk-sky ap-auth__sky" data-phase={appearance.phase} aria-hidden="true">
      <div class="vk-sky__sun"></div>
    </div>
  {/if}
  <div class={["ap-auth__body", center && "ap-auth__body--center"]}>
    {@render children()}
  </div>
</main>
