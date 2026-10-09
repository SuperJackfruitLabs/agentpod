<script lang="ts">
  /**
   * Where the organization plane sends the browser back after authorize (redirect URI
   * `<console origin>/auth/callback`, registered for the `agentpod-console` client). Trades the
   * code for tokens, restores the user from the hub, and goes where the sign-in was for.
   */
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { beginSignIn, completeSignIn, suppressAutoSignIn } from "$lib/auth/org-plane";
  import { relaySuperlibraryCallback } from "$lib/auth/superlibrary-grant";
  import { auth, currentPlane, getAuthApiUrl, initAuth, resetAuthInit } from "$lib/stores/auth.svelte";
  import { hardNavigate, resolveReturnTo } from "$lib/utils/return-to";

  let message = $state("Signing you in…");
  let failed = $state(false);

  onMount(async () => {
    // Superlibrary's own sign-in (a separate grant) lands here too, in the small window "Link this
    // file" opened: hand the answer to the page that opened it, which trades the code.
    if (relaySuperlibraryCallback(window.location.search)) {
      message = "Signing you in to Superlibrary…";
      return;
    }
    const p = currentPlane();
    if (!p) {
      failed = true;
      message = "This hub does not use an account service. Return to sign-in.";
      return;
    }
    try {
      const { returnTo, interactive } = await completeSignIn(new URLSearchParams(window.location.search), p);
      if (interactive) {
        // The automatic (prompt=none) authorize found no plane session, or the plane needs the
        // person for something (a workspace, consent): ask again, and let the plane show its page.
        message = "Taking you to sign in…";
        await beginSignIn(p, { returnTo });
        return;
      }
      // The layout's initAuth already ran, signed out, before the plane sent us back.
      resetAuthInit();
      await initAuth();
      if (!auth.isAuthenticated) {
        // The hub would not have the new token (e.g. 403 product_not_enabled). Going on would send
        // the guard straight back to the plane for another token the hub refuses: stop here.
        suppressAutoSignIn();
        failed = true;
        message = auth.error ?? "The hub did not accept the sign-in.";
        return;
      }
      // The return path was ours to begin with, but it went through sessionStorage: same allowlist
      // as the password sign-in (this origin, or the connected hub's).
      const target = resolveReturnTo(returnTo, getAuthApiUrl(), window.location.origin);
      if (target.startsWith("/")) await goto(target, { replaceState: true });
      else hardNavigate(target);
    } catch (err) {
      failed = true;
      message = err instanceof Error ? err.message : "Sign-in failed.";
    }
  });
</script>

<svelte:head>
  <title>Signing in · AgentPod</title>
</svelte:head>

<main class="flex min-h-screen items-center justify-center bg-background p-4">
  <div class="space-y-3 text-center">
    <p role={failed ? "alert" : "status"} class="text-sm {failed ? 'text-destructive' : 'text-muted-foreground'}">{message}</p>
    {#if failed}
      <a href="/login" class="text-sm text-primary hover:underline">Back to sign-in</a>
    {/if}
  </div>
</main>
