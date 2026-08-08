<script lang="ts">
  import { auth, loginWithEmail, signUp, clearError, initAuth } from "$lib/stores/auth.svelte";
  import { connection, connect, disconnect } from "$lib/stores/connection.svelte";
  import { goto } from "$app/navigation";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Field } from "$lib/components/ui/field";
  import { Spinner } from "$lib/components/ui/spinner";
  import Server from "@lucide/svelte/icons/server";
  import Circle from "@lucide/svelte/icons/circle";
  import { statusTextClass } from "$lib/utils/status-badge";

  // Form state
  let apiUrl = $state(import.meta.env.PUBLIC_HUB_URL ?? "http://localhost:3001");
  let isConnecting = $state(false);
  let connectionError = $state<string | null>(null);

  // Auth form state
  let authMode = $state<"signin" | "signup">("signin");
  let email = $state("");
  let password = $state("");
  let name = $state("");

  // Signup status
  let signupEnabled = $state(true);
  let signupMessage = $state<string | null>(null);

  // Determine current step - wait for connection to be initialized
  let step = $derived<"setup" | "login">(
    connection.isConnected && connection.apiUrl ? "login" : "setup"
  );

  // Check signup status when connected. Raw fetch (not the API client) — this
  // runs pre-auth, before there's a session for the client to attach.
  async function checkSignupStatus(url: string) {
    try {
      const response = await fetch(`${url}/api/auth/signup-status`);
      if (response.ok) {
        const data = await response.json();
        signupEnabled = data.enabled;
        signupMessage = data.message;
        // If signup is disabled and user is trying to signup, switch to signin
        if (!signupEnabled && authMode === "signup") {
          authMode = "signin";
        }
      }
    } catch (e) {
      // If we can't check, assume signup is enabled
      signupEnabled = true;
    }
  }

  // Check signup status when connection changes — guarded so it only fires
  // once per apiUrl rather than on every unrelated connection state tick.
  let lastCheckedApiUrl: string | null = null;
  $effect(() => {
    if (connection.isConnected && connection.apiUrl && connection.apiUrl !== lastCheckedApiUrl) {
      lastCheckedApiUrl = connection.apiUrl;
      checkSignupStatus(connection.apiUrl);
    }
  });

  async function handleSetup(e: Event) {
    e.preventDefault();
    isConnecting = true;
    connectionError = null;

    // Connect without API key - we'll use OAuth tokens instead
    const success = await connect(apiUrl, undefined);

    if (success) {
      // Connection established → the auth client now has a baseURL. Attempt to
      // restore an existing cookie session; the redirect $effect routes home if
      // one is found, otherwise the login form is shown.
      await initAuth();
    } else {
      connectionError = connection.error || "Connection failed";
    }

    isConnecting = false;
  }

  async function handleEmailSubmit(e: Event) {
    e.preventDefault();
    clearError();

    let success = false;
    if (authMode === "signin") {
      success = await loginWithEmail(email, password);
    } else {
      success = await signUp(email, password, name);
    }

    if (success) {
      // Redirect immediately after successful auth
      // The session cookie is set, so we're authenticated
      goto("/");
    }
  }

  function toggleAuthMode() {
    // Only allow toggling to signup if signup is enabled
    if (authMode === "signin" && !signupEnabled) {
      return; // Can't switch to signup if disabled
    }
    authMode = authMode === "signin" ? "signup" : "signin";
    clearError();
  }

  // Redirect to homepage if already authenticated
  $effect(() => {
    if (auth.isAuthenticated && connection.isConnected) {
      goto("/");
    }
  });
</script>

{#snippet errorBanner(message: string)}
  <div class="rounded-lg border border-destructive/50 bg-destructive/5 p-3" role="alert">
    <p class="text-sm text-destructive">{message}</p>
  </div>
{/snippet}

<main class="min-h-screen bg-background flex items-center justify-center p-4 sm:p-6">
  <div class="w-full max-w-md rounded-lg border bg-card p-6 space-y-6">
    <!-- Brand -->
    <div class="flex flex-col items-center gap-3 text-center">
      <div class="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Server class="size-5" />
      </div>
      <div>
        <h1 class="text-lg font-semibold">AgentPod</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          {#if step === "setup"}
            Connect to your hub
          {:else if authMode === "signin"}
            Sign in
          {:else}
            Create account
          {/if}
        </p>
      </div>
    </div>

    {#if step === "setup"}
      <!-- Setup Step -->
      <form onsubmit={handleSetup} class="space-y-5">
        <Field label="API Endpoint" for="api-url" description="Enter your AgentPod Management API URL">
          <Input
            id="api-url"
            name="hub-url"
            type="url"
            placeholder="http://localhost:3001"
            autocomplete="url"
            spellcheck={false}
            bind:value={apiUrl}
            required
            class="font-mono text-sm"
          />
        </Field>

        {#if connectionError}
          {@render errorBanner(connectionError)}
        {/if}

        <Button type="submit" class="w-full" disabled={isConnecting || !apiUrl}>
          {#if isConnecting}
            <Spinner size="sm" class="text-primary-foreground" />
            Connecting…
          {:else}
            Connect
          {/if}
        </Button>
      </form>
    {:else}
      <!-- Login Step -->
      <div class="space-y-5">
        <!-- Connection Info -->
        <div class="flex items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
          <Circle class="h-2.5 w-2.5 fill-current {statusTextClass('connected')}" />
          <span class="text-muted-foreground">Connected to</span>
          <span class="truncate text-foreground">{connection.apiUrl}</span>
        </div>

        {#if auth.error}
          {@render errorBanner(auth.error)}
        {/if}

        <!-- Email/Password Form -->
        <form onsubmit={handleEmailSubmit} class="space-y-4">
          {#if authMode === "signup"}
            <Field label="Name" for="name">
              <Input
                id="name"
                name="name"
                type="text"
                placeholder="Your name"
                autocomplete="name"
                bind:value={name}
                required
                disabled={auth.isLoading}
              />
            </Field>
          {/if}

          <Field label="Email" for="email">
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="you@example.com"
              autocomplete="email"
              spellcheck={false}
              bind:value={email}
              required
              disabled={auth.isLoading}
            />
          </Field>

          <Field
            label="Password"
            for="password"
            description={authMode === "signup" ? "Minimum 8 characters" : undefined}
          >
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="••••••••"
              autocomplete={authMode === "signup" ? "new-password" : "current-password"}
              bind:value={password}
              required
              minlength={8}
              disabled={auth.isLoading}
            />
          </Field>

          <Button type="submit" class="w-full" disabled={auth.isLoading}>
            {#if auth.isLoading}
              <Spinner size="sm" class="text-primary-foreground" />
              {authMode === "signin" ? "Signing in…" : "Creating…"}
            {:else}
              {authMode === "signin" ? "Sign in" : "Create account"}
            {/if}
          </Button>
        </form>

        <!-- Toggle auth mode -->
        <div class="text-center text-sm">
          {#if signupEnabled}
            {#if authMode === "signin"}
              <span class="text-muted-foreground">No account? </span>
              <button type="button" class="text-primary hover:underline" onclick={toggleAuthMode}>
                Create one
              </button>
            {:else}
              <span class="text-muted-foreground">Have an account? </span>
              <button type="button" class="text-primary hover:underline" onclick={toggleAuthMode}>
                Sign in
              </button>
            {/if}
          {:else}
            <!-- Signup disabled message -->
            <div class="rounded-lg border bg-muted/30 p-3">
              <p class="text-xs text-muted-foreground">
                {signupMessage || "Public registration is disabled. Contact an administrator to create an account."}
              </p>
            </div>
          {/if}
        </div>

        <!-- Change server -->
        <Button variant="ghost" class="w-full text-muted-foreground hover:text-foreground" onclick={disconnect}>
          ← Use different server
        </Button>
      </div>
    {/if}
  </div>
</main>
