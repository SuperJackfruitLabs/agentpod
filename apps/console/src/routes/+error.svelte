<script lang="ts">
  import { page } from "$app/state";
  import { Button } from "$lib/components/ui/button";

  const notFound = $derived(page.status === 404);

  /** A failed load is often a passing one (the hub restarting, a dropped connection): offer the retry. */
  function reload() {
    window.location.reload();
  }
</script>

<svelte:head>
  <title>{notFound ? "Page not found" : "Something went wrong"} · AgentPod</title>
</svelte:head>

<div class="ap-err">
  <p class="ap-err__code">{page.status}</p>
  <h1 class="ap-err__h">
    {notFound ? "Page not found" : "Something went wrong"}
  </h1>
  <p class="ap-err__p">
    {notFound
      ? "This page doesn't exist — it may have been moved or removed."
      : (page.error?.message ?? "An unexpected error occurred.")}
  </p>
  <div class="ap-err__acts">
    {#if !notFound}
      <Button onclick={reload}>Reload</Button>
    {/if}
    <Button href="/" variant="outline">Back to Overview</Button>
  </div>
</div>
