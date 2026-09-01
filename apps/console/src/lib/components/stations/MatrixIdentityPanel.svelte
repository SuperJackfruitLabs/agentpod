<script lang="ts">
  /**
   * The §1 invariant, made visible and actionable
   * (`docs/superpowers/specs/2026-09-01-uniform-matrix-identity-design.md` §6).
   *
   * **Where the states come from, and why they stopped coming from here.**
   * This panel used to read two columns off the station row —
   *
   *   matrixId === null           → bridge mode, the appservice speaks for it
   *   matrixId === bridgeMatrixId → converged
   *   otherwise                   → running under a retired identity
   *
   * — and the middle line is not true. `bridgeMatrixId` is what the appservice
   * minted, and for a harness station `provision.ts` writes the station's OWN
   * address into it. On the fleet all 14 harness stations carry
   * `matrixId === bridgeMatrixId`, both holding the old station-derived
   * address, so this panel showed every one of them as converged and offered
   * nobody the move. The feature was invisible and inert.
   *
   * The question the panel means to ask is *"is this agent on its principal's
   * address?"*, and only the agent's handle answers that. The browser holds no
   * handle and no homeserver domain, so it cannot derive that address — **the
   * hub says it**, through `matrix/move-state`, and this panel renders what it
   * is told rather than re-deriving three of the four states from a column
   * that answers a different question. `matrixId === null` is the one part of
   * the invariant a raw column really does settle, so bridge mode is still
   * answered here, without a round trip.
   *
   * **Converged is not "healthy".** Room membership is a Matrix fact that no
   * column and no state here carries — a station can hold the right credential
   * and still be unable to post (a gate `failed` outcome, `M_FORBIDDEN`, is
   * how that shows up, counted by the sweep). This panel says only that the
   * identity switched. Judging whether it can actually speak is the hub's own
   * gate sweep's job — its logs, its tally of non-`sent` outcomes — not this
   * component's, and not any console view, because the console has none for
   * that yet (§6 called for one; no task built it). Pointing an operator at a
   * UI element that doesn't exist would recreate, in the console, exactly the
   * silence this slice exists to remove.
   *
   * **The move is fire-and-forget.** `authorize-move` puts the new identity in
   * the room and signals the node, but the node adopts on its own time — or
   * never, if it's offline, in which case the authorization simply expires.
   * So a successful call does not end this panel's job: it moves to "waiting
   * for the node", with the control still live, because re-authorizing IS the
   * retry. A control that vanishes on click is the failure to avoid.
   */

  import { Button } from "$lib/components/ui/button";
  import {
    authorizeMove as defaultAuthorizeMove,
    stationMoveState as defaultMoveState,
    type StationMoveState,
  } from "$lib/api/client";

  interface StationIdentity {
    id: string;
    /**
     * What the harness reports it answers as. Null is bridge mode and is the
     * one state this component still decides for itself — `matrix_id IS NULL`
     * means the appservice speaks for the station, and no address needs
     * deriving to know it.
     *
     * `bridgeMatrixId` is deliberately NOT read here, or accepted: it is what
     * the appservice minted, not what this station's principal implies, and
     * comparing against it is the defect this panel carried.
     */
    matrixId: string | null;
  }

  interface Props {
    station: StationIdentity;
    /** Injectable for tests; defaults to the real hub call. */
    authorize?: (stationId: string) => Promise<{ expiresAt: string }>;
    /**
     * Where the hub says this station stands. Injectable for the same reason.
     * Every state but bridge mode is read from it, because every one of them
     * turns on an address only the hub can build.
     */
    moveState?: (stationId: string) => Promise<StationMoveState>;
  }

  let { station, authorize = defaultAuthorizeMove, moveState = defaultMoveState }: Props = $props();

  /** What the hub last said, or null while nothing has been heard. */
  let hubState = $state<StationMoveState | null>(null);
  /** The hub could not be asked. Distinct from "not asked yet" — see below. */
  let unanswered = $state(false);

  type IdentityState = "bridge" | "converged" | "retired" | "no-agent" | "unasked" | "pending";

  // Named identityState, not state: a local binding literally named `state`
  // collides with Svelte's `$state` rune (`$state<Phase>(...)` below reads as
  // an auto-subscription to a store called `state` once one exists in scope),
  // which is a compile error the two runes' similar names make easy to trip.
  const identityState = $derived<IdentityState>(
    station.matrixId === null
      ? "bridge"
      : unanswered
        ? "unasked"
        : hubState === null
          ? "pending"
          : hubState.status === "converged"
            ? "converged"
            : hubState.status === "no-agent"
              ? "no-agent"
              : hubState.status === "waiting" || hubState.status === "retired-identity"
                ? "retired"
                : // `bridge` (the row changed under us) and `unknown` (the
                  // station is gone) are both "nothing to offer here".
                  hubState.status === "bridge"
                  ? "bridge"
                  : "unasked"
  );

  /** The address the station answers as today, as the hub reports it. */
  const runningAs = $derived(
    hubState && "runningAs" in hubState ? hubState.runningAs : station.matrixId
  );
  /** The address its principal's handle implies — the hub's answer, never ours. */
  const willBecome = $derived(hubState && "willBecome" in hubState ? hubState.willBecome : null);

  type Phase = "idle" | "authorizing" | "waiting";

  let phase = $state<Phase>("idle");
  let error = $state<string | null>(null);
  let expiresAt = $state<string | null>(null);
  /** When the outstanding authorization was made, per the hub. */
  let waitingSince = $state<string | null>(null);

  /**
   * Ask the hub where this station stands.
   *
   * Not an optional embellishment any more: `waiting` was always the hub's to
   * answer, because it is derived from an authorization record the browser
   * never sees — and now `converged` and `retired-identity` are too, because
   * both turn on the address the occupying principal's handle implies and the
   * browser has neither the handle nor the domain to build it.
   *
   * A failure therefore costs more than it used to, and must say so: without
   * an answer this panel does not know whether a move is available, and
   * offering one anyway would be a control built on the guess this component
   * was just relieved of.
   */
  // Deliberately NOT `$state`: it is a record of what has been asked, not a
  // thing to render, and a reactive one written inside the effect below would
  // re-trigger it. The station page passes `station` as a fresh object on
  // every render, so without this the panel would re-ask the hub on every
  // unrelated page update.
  let askedFor: string | null = null;

  $effect(() => {
    const id = station.id;
    // Bridge mode is the column's own answer, and there is nothing to offer
    // for it — no request, and none of the states below.
    if (!id || station.matrixId === null) return;
    if (askedFor === id) return;
    askedFor = id;

    // **Everything below this line describes ONE station, so a new station
    // starts from nothing.** The route reuses this component across stations
    // — `[stationId]/+page.svelte` is one page, not one per station — so
    // without this reset an operator who opens B after A reads A's answer
    // until B's arrives: A's `willBecome` in the sentence, and A's move
    // behind the button. Clicking it authorises B to move to an address
    // derived from A's agent. `unanswered` was worse still: write-once-true,
    // so one unreachable hub latched "Couldn't ask the hub" onto every
    // station visited for the rest of the session.
    //
    // `phase` and its two companions go with them for the same reason: a
    // click on A must not leave B saying it is waiting for a node to redeem
    // an authorisation nobody minted for it.
    hubState = null;
    unanswered = false;
    phase = "idle";
    waitingSince = null;
    expiresAt = null;
    error = null;

    let live = true;
    void moveState(id)
      .then((s) => {
        // The answer to a question about a station this panel has since
        // navigated away from. `live` is cleared by the cleanup below when
        // the effect re-runs, which is the only reason a late reply cannot
        // overwrite the state the reset above just cleared.
        if (!live) return;
        hubState = s;
        // A click in flight, or one that already set the local waiting state,
        // outranks a reply about how things stood before it. Ruling 17's
        // guard, kept: the control now renders only after an answer, so a
        // click can no longer overtake this panel's own request for the same
        // station — but it costs one comparison, and any future change that
        // renders the control earlier restores the race it was written for.
        if (phase !== "idle") return;
        if (s.status === "waiting") {
          waitingSince = s.since;
          phase = "waiting";
        }
      })
      .catch(() => {
        if (live) unanswered = true;
      });
    return () => {
      live = false;
    };
  });

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
      waitingSince = null;
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
      authenticates as <code class="font-mono break-all">{runningAs}</code>,
      but its account is now
      <code class="font-mono break-all">{willBecome}</code>.
    </p>

    {#if error}
      <p class="text-sm text-destructive" role="alert">{error}</p>
    {/if}

    {#if phase === "waiting"}
      <p class="text-sm text-muted-foreground" role="status">
        Waiting for the node to redeem this authorization{expiresAt
          ? ` (expires ${fmt(expiresAt)})`
          : waitingSince
            ? ` (authorized ${fmt(waitingSince)})`
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
      <code class="font-mono break-all">{runningAs}</code>. Whether it can
      actually post in its room is a separate fact neither column carries — the
      hub's own gate sweep is the one thing that checks it, in its logs and its
      tally of non-<code class="font-mono">sent</code> outcomes, not here.
    </p>
  </div>
{:else if identityState === "no-agent"}
  <!--
    No agent occupies this station, so there is no handle, so there is no
    address to move it to. Said rather than left blank: a station answering as
    an mxid no principal owns is a thing an operator needs to see, and offering
    a move with no target would be a button that can only fail.
  -->
  <div class="rounded-lg border p-4" data-testid="matrix-identity-panel">
    <p class="text-sm text-muted-foreground">
      This station answers as <code class="font-mono break-all">{runningAs}</code>,
      but no agent occupies it — so there is no identity of its own to move it
      to. Assign an agent first.
    </p>
  </div>
{:else if identityState === "unasked"}
  <div class="rounded-lg border p-4" data-testid="matrix-identity-panel">
    <p class="text-sm text-muted-foreground" role="status">
      Couldn't ask the hub where this agent's Matrix identity stands, so no
      move is offered here. The address it would move to is derived from its
      agent's handle, which only the hub can build.
    </p>
  </div>
{/if}
