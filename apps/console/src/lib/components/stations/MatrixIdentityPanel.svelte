<script lang="ts">
  /**
   * The §1 invariant, made visible and actionable
   * (`docs/superpowers/specs/2026-09-01-uniform-matrix-identity-design.md` §6).
   *
   * There is no status column for this — `matrixId` (what the harness reports)
   * and `bridgeMatrixId` (what the appservice minted) are read straight off the
   * station row:
   *
   *   matrixId === null           → bridge mode, the appservice speaks for it
   *   matrixId === bridgeMatrixId → converged
   *   otherwise                   → running under a retired identity
   *
   * **Converged is not "healthy".** Room membership is a Matrix fact that lives
   * in neither column — a station can hold the right credential and still be
   * unable to post (a gate `failed` outcome, `M_FORBIDDEN`, is how that shows
   * up, counted by the sweep). This panel says only what the two columns know:
   * that the identity switched. Judging whether it can actually speak is the
   * hub's own gate sweep's job — its logs, its tally of non-`sent` outcomes —
   * not this component's, and not any console view, because the console has
   * none for that yet (§6 called for one; no task built it). Pointing an
   * operator at a UI element that doesn't exist would recreate, in the
   * console, exactly the silence this slice exists to remove.
   *
   * **The move is fire-and-forget.** `authorize-move` puts the new identity in
   * the room and signals the node, but the node adopts on its own time — or
   * never, if it's offline, in which case the authorization simply expires.
   * So a successful call does not end this panel's job: it moves to "waiting
   * for the node", with the control still live, because re-authorizing IS the
   * retry. A control that vanishes on click is the failure to avoid.
   */

  import { Button } from "$lib/components/ui/button";
  import { authorizeMove as defaultAuthorizeMove } from "$lib/api/client";

  interface StationIdentity {
    // Optional: the converged/bridge states never call authorize() and so
    // never need it — only a station actually rendering the control has to
    // supply one.
    id?: string;
    matrixId: string | null;
    bridgeMatrixId: string | null;
  }

  interface Props {
    station: StationIdentity;
    /** Injectable for tests; defaults to the real hub call. */
    authorize?: (stationId: string) => Promise<{ expiresAt: string }>;
  }

  let { station, authorize = defaultAuthorizeMove }: Props = $props();

  type IdentityState = "bridge" | "converged" | "retired";

  // Named identityState, not state: a local binding literally named `state`
  // collides with Svelte's `$state` rune (`$state<Phase>(...)` below reads as
  // an auto-subscription to a store called `state` once one exists in scope),
  // which is a compile error the two runes' similar names make easy to trip.
  const identityState = $derived<IdentityState>(
    station.matrixId === null
      ? "bridge"
      : station.matrixId === station.bridgeMatrixId
        ? "converged"
        : "retired"
  );

  type Phase = "idle" | "authorizing" | "waiting";

  let phase = $state<Phase>("idle");
  let error = $state<string | null>(null);
  let expiresAt = $state<string | null>(null);

  function fmt(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  async function move() {
    if (!station.id) return; // only the "retired" branch below ever renders the button that calls this
    phase = "authorizing";
    error = null;
    try {
      const result = await authorize(station.id);
      expiresAt = result.expiresAt;
      // Not "done" — the node hasn't redeemed anything yet. The control stays
      // live below rather than being replaced by a spinner the operator can't
      // escape: if the node never answers, pressing it again IS the retry.
      phase = "waiting";
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't authorize this move.";
      phase = "idle";
    }
  }
</script>

{#if identityState === "retired"}
  <div class="rounded-lg border p-4 space-y-3" data-testid="matrix-identity-panel">
    <p class="text-sm">
      This agent is running under a <strong>retired identity</strong>: it
      authenticates as <code class="font-mono break-all">{station.matrixId}</code>,
      but its account is now
      <code class="font-mono break-all">{station.bridgeMatrixId}</code>.
    </p>

    {#if error}
      <p class="text-sm text-destructive" role="alert">{error}</p>
    {/if}

    {#if phase === "waiting"}
      <p class="text-sm text-muted-foreground" role="status">
        Waiting for the node to redeem this authorization{expiresAt
          ? ` (expires ${fmt(expiresAt)})`
          : ""}. If the node is offline the authorization simply expires —
        pressing the button again is the retry.
      </p>
    {/if}

    <Button size="sm" disabled={phase === "authorizing"} onclick={() => void move()}>
      {phase === "authorizing" ? "Authorizing…" : "Move to its own identity"}
    </Button>
  </div>
{:else if identityState === "converged"}
  <div class="rounded-lg border p-4" data-testid="matrix-identity-panel">
    <p class="text-sm text-muted-foreground">
      This agent's identity has switched to
      <code class="font-mono break-all">{station.matrixId}</code>. Whether it can
      actually post in its room is a separate fact neither column carries — the
      hub's own gate sweep is the one thing that checks it, in its logs and its
      tally of non-<code class="font-mono">sent</code> outcomes, not here.
    </p>
  </div>
{/if}
