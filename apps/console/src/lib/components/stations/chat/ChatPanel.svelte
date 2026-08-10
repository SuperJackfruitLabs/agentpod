<script lang="ts">
  /**
   * ChatPanel — the station's Chat tab: one AcpChat session controller wired to
   * the header (status/mode/session actions), the transcript, and the composer.
   *
   * Sizing mirrors Terminal.svelte: a full-height bordered column whose middle
   * row (the transcript) is the only scroller — `flex-1 min-h-0` so a long
   * conversation never pushes the composer off screen.
   *
   * The controller owns every refusal rule and the ONE status both the header and
   * the composer read (`chat.status`) — a header saying "Working…" over an
   * enabled Send button is how a prompt gets sent into someone else's turn and
   * rejected. `chat.busy` is true exactly when `prompt()` would refuse (create in
   * flight / optimistic prompt awaiting its echo / agent working / replay in
   * flight), and PromptInput only preserves a draft it wasn't allowed to send —
   * so `busy` must reach it as `working` (mid-turn, where Stop is the action) or
   * `disabled` (every other refusal window).
   *
   * A prompt the hub rejects, or one lost with the socket, hands its text back
   * through `onPromptFailed` — the controller drops the ghost bubble (which would
   * otherwise keep `busy` true forever) and the draft reappears in the composer.
   *
   * Failures surface twice on purpose: an inline strip above the composer (with
   * Retry when the transport is dead) plus a toast for a failed session create,
   * which is the one failure that leaves nothing on screen to explain itself.
   *
   * A station can host several sessions at once, so this panel is a view onto
   * ONE of them: the header's switcher picks, `chat.attach` swaps the socket and
   * the transcript. The panel is deliberately not remounted per session — the
   * socket lifecycle belongs to the controller, and remounting would also throw
   * away the draft and the scroll position on every switch.
   */
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { AcpChat } from "./acp-chat.svelte";
  import ChatHeader from "./ChatHeader.svelte";
  import Conversation from "./Conversation.svelte";
  import PromptInput from "./PromptInput.svelte";
  import SessionHistory from "./SessionHistory.svelte";

  interface Props {
    stationId: string;
  }

  let { stationId }: Props = $props();

  /** The composer's draft, owned here so a failed prompt can be handed back. */
  let draft = $state("");

  /**
   * Drafts are PER SESSION: switching away from A parks A's text here, switching
   * back restores it, and B always shows B's own (empty until B has one).
   *
   * The two single-buffer alternatives are both wrong. Carrying one draft across
   * a switch leaves words written for one agent one Enter away from another —
   * and the header above it now says a different session. Clearing on switch
   * destroys text the user typed, which is the one thing this panel never does
   * anywhere else (a refused send keeps its draft; a rejected prompt is handed
   * back through `onPromptFailed`). Parking per session loses nothing and can
   * misdirect nothing. Entries are dropped when a session ends — there is no
   * composer to return to.
   *
   * "No session attached" is a slot of its own (`NEW_SESSION_SLOT`): with every
   * session ended the switcher is up while nothing is attached, so a draft typed
   * there has no session id to be filed under. It is parked all the same, and the
   * next session CREATED inherits it — that text was written for whichever
   * session came next, and creating one is what makes it exist.
   *
   * Text typed while an ENDED session is attached lands in that same slot: the
   * composer there is ALREADY a new-session composer (the notice below says so,
   * and `prompt()` creates), so its words belong to the next session, not to the
   * dead one. Filing them under the ended session's own id is how "New session"
   * used to lose them — the pruning effect below garbage-collects that slot.
   */
  const drafts = new Map<string, string>();

  /** Draft slot for "nothing attached". Not a valid session id, so it can't collide. */
  const NEW_SESSION_SLOT = "__new-session__";
  const draftSlot = (sessionId: string | null) => sessionId ?? NEW_SESSION_SLOT;

  /**
   * Which session is on screen. The panel owns this pick; the controller owns
   * the socket for it. Deliberately NOT an `$effect` reconciling `selectedId`
   * against `chat.session`: an effect re-runs on every controller state change,
   * so creating a session from the header (which moves `chat.session`, not the
   * pick) would immediately be switched away from again. A switch happens once,
   * in the handler for the thing the user actually clicked.
   */
  let selectedId = $state<string | null>(null);

  /**
   * The full session history (a dialog, so this panel stays mounted behind it —
   * the socket, the transcript and the draft all survive browsing). Owned here
   * because the pick it produces belongs to `selectSession`, not to the header.
   */
  let historyOpen = $state(false);

  // Plain (non-reactive) ref: the controller holds its own $state internally,
  // so the template stays reactive while the instance itself is stable for the
  // lifetime of the panel. The station is fixed at construction on purpose —
  // the station page keys this panel on `stationId`, so a different station
  // gets a fresh panel (and a fresh socket) rather than a rebound controller.
  // svelte-ignore state_referenced_locally
  let chat = new AcpChat(stationId, {
    onPromptFailed: (text) => {
      // Don't clobber something the user has already started typing instead.
      if (draft.trim().length === 0) draft = text;
    },
  });

  onMount(() => {
    void chat.init();
    // Unmount (including a tab switch that drops this panel) closes the socket
    // only — the session keeps running on the hub and is re-attached on return.
    return () => chat.destroy();
  });

  /**
   * Park the on-screen draft under the slot being left and load the slot being
   * landed on. A no-op when nothing moved, so a refused switch (a session that is
   * gone) or a failed create leaves the composer exactly as the user left it.
   *
   * `created` marks the landing session as brand new, which is the one case that
   * inherits the pre-session draft — see NEW_SESSION_SLOT.
   *
   * `fromEnded` says the session being left had ENDED, which redirects the park
   * to NEW_SESSION_SLOT: nothing can be sent into that session again, so text
   * written there is destined for the next one (and the pruning effect below
   * would otherwise collect it).
   */
  function swapDraft(from: string | null, to: string | null, created = false, fromEnded = false) {
    if (from === to) return; // nothing moved — don't touch the composer
    const fromSlot = fromEnded ? NEW_SESSION_SLOT : draftSlot(from);
    const toSlot = draftSlot(to);
    if (fromSlot === toSlot) return;

    if (draft.length > 0) drafts.set(fromSlot, draft);
    // Never leave a stale entry under the slot we actually left: an empty
    // composer parks nothing, and a redirected park must not also keep a copy
    // filed under the ended session's own id.
    if (draft.length === 0 || fromSlot !== draftSlot(from)) drafts.delete(draftSlot(from));

    if (created && !drafts.has(toSlot)) {
      const preSession = drafts.get(NEW_SESSION_SLOT);
      if (preSession !== undefined) {
        drafts.set(toSlot, preSession);
        drafts.delete(NEW_SESSION_SLOT);
      }
    }
    draft = drafts.get(toSlot) ?? "";
  }

  /**
   * Point the header and the drafts at whatever the controller actually attached.
   * `fromEnded` must be read BEFORE the attach/create — by the time this runs,
   * `chat.status` describes the session just landed on.
   */
  function settleOn(from: string | null, created: boolean, fromEnded = false) {
    const landed = chat.session?.id ?? null;
    selectedId = landed;
    swapDraft(from, landed, created, fromEnded);
    return landed;
  }

  async function selectSession(id: string) {
    const from = chat.session?.id ?? null;
    if (id === from) return; // already on it — don't touch the socket or the draft
    const fromEnded = chat.status === "ended";
    selectedId = id;
    await chat.attach(id);
    // A refused switch leaves the previous session attached, so the header must
    // fall back to what is really on screen.
    settleOn(from, false, fromEnded);
  }

  async function startSession() {
    const from = chat.session?.id ?? null;
    const fromEnded = chat.status === "ended";
    await chat.newSession();
    const landed = settleOn(from, true, fromEnded);
    // Same reasoning as a failed first prompt: the strip shows it, but a toast is
    // what gets noticed when the transcript below hasn't changed.
    if (chat.error !== null && landed === from) {
      toast.error("Couldn't start the session", { description: chat.error });
    }
  }

  /**
   * An ended session is attachable (its transcript is worth reading), and the
   * composer stays usable there rather than stranding the user in a read-only
   * dead end — `prompt()` creates a fresh session for the text. But that also
   * starts a new agent process on the host, so it is said out loud instead of
   * happening silently under a header that reads "ended".
   */
  const endedNotice = $derived(chat.session !== null && chat.status === "ended");
  const endedNoticeId = $props.id();

  // A parked draft for a session that has since ended is dead post — nothing can
  // be sent into that session again, so drop it rather than hand it back on a
  // switch into a read-only replay. Only the MAP is pruned: text the user can
  // still see in the composer is never destroyed (with an ended session attached,
  // sending it creates a new session — see `prompt()`'s lazy create).
  $effect(() => {
    for (const s of chat.sessions) {
      if (s.status === "ended") drafts.delete(s.id);
    }
  });

  async function handleSend(text: string) {
    // The composer is already disabled in every refusal window; this guard just
    // keeps a stale `error` from being re-toasted if one slips through.
    if (chat.busy) return;
    const beforeId = chat.session?.id ?? null;
    const needsCreate = beforeId === null || chat.status === "ended";

    await chat.prompt(text);

    // Sending is a THIRD way the attached session changes: with nothing attached,
    // or while reading an ended one, `prompt()` creates a session first. The pick
    // has to follow, or the header names the session the user was reading while
    // the transcript below it belongs to a different one — and the stale pick then
    // swallows the next click on either of them.
    const landed = settleOn(beforeId, needsCreate, beforeId !== null && needsCreate);

    // A create that failed leaves the session unchanged and the message in
    // `chat.error` — the strip shows it, but a toast is what gets noticed when
    // the panel is otherwise empty.
    if (needsCreate && chat.error !== null && landed === beforeId) {
      toast.error("Couldn't start the session", { description: chat.error });
    }
  }
</script>

<div class="flex h-full min-h-[320px] flex-col overflow-hidden rounded-lg border bg-background">
  <div class="shrink-0 border-b px-3 py-2">
    <ChatHeader
      session={chat.session}
      sessions={chat.sessions}
      selectedId={selectedId ?? chat.session?.id ?? null}
      status={chat.status}
      connection={chat.connection}
      mode={chat.mode}
      creating={chat.creating}
      onModeChange={(mode) => chat.setMode(mode)}
      onEnd={() => {
        // While disconnected the DELETE still lands, but the ended state
        // arrives over the event stream — the strip keeps saying "disconnected"
        // until a retry reconnects and replays it. That's the honest reading.
        void chat.end();
      }}
      onNew={() => void startSession()}
      onSelectSession={(id) => void selectSession(id)}
      onOpenHistory={() => (historyOpen = true)}
    />
  </div>

  <div class="min-h-0 flex-1">
    <Conversation
      items={chat.transcript.items}
      onAnswer={(requestSeq, optionId) => chat.answer(requestSeq, optionId)}
    />
  </div>

  {#if chat.error}
    <div class="flex shrink-0 items-center gap-2 border-t px-3 py-1.5" role="alert">
      <p class="t-label min-w-0 flex-1 text-status-error">{chat.error}</p>
      {#if chat.connection === "disconnected"}
        <Button variant="ghost" size="xs" onclick={() => chat.retry()}>Retry</Button>
      {/if}
    </div>
  {/if}

  <div class="shrink-0 border-t p-3">
    {#if endedNotice}
      <!-- Not a live region: the header owns the ONE status announcement. This is
           the composer's description, read when focus lands on it. -->
      <p id={endedNoticeId} class="t-label mb-2 text-muted-foreground">
        This session has ended — sending starts a new one.
      </p>
    {/if}
    <PromptInput
      bind:value={draft}
      working={chat.working}
      disabled={chat.busy && !chat.working}
      describedBy={endedNotice ? endedNoticeId : undefined}
      onSend={handleSend}
      onCancel={() => chat.cancel()}
    />
  </div>
</div>

<!-- Mounted only while open, so its list is re-read (and starts at page 1) each
     time — a station's sessions move while the dialog is shut. Selecting there
     goes through the SAME selectSession/settleOn path as the switcher: a second
     attach path is exactly what left the header naming a session the user
     wasn't in. -->
{#if historyOpen}
  <SessionHistory
    {stationId}
    currentSessionId={chat.session?.id ?? null}
    onSelect={(id) => void selectSession(id)}
    onClose={() => (historyOpen = false)}
  />
{/if}
