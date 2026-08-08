<script lang="ts">
  import { page } from "$app/state";
  import { Button } from "$lib/components/ui/button";

  const notFound = $derived(page.status === 404);
</script>

<svelte:head>
  <title>{notFound ? "Page not found" : "Something went wrong"} · AgentPod</title>
</svelte:head>

<div class="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
  <p class="font-mono text-sm text-muted-foreground">{page.status}</p>
  <h1 class="text-lg font-semibold">
    {notFound ? "Page not found" : "Something went wrong"}
  </h1>
  <p class="max-w-sm text-sm text-muted-foreground">
    {notFound
      ? "This page doesn't exist — it may have been moved or removed."
      : (page.error?.message ?? "An unexpected error occurred.")}
  </p>
  <Button href="/" variant="outline">Back to Overview</Button>
</div>
