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
   */
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { AcpChat } from "./acp-chat.svelte";
  import ChatHeader from "./ChatHeader.svelte";
  import Conversation from "./Conversation.svelte";
  import PromptInput from "./PromptInput.svelte";

  interface Props {
    stationId: string;
  }

  let { stationId }: Props = $props();

  /** The composer's draft, owned here so a failed prompt can be handed back. */
  let draft = $state("");

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

  async function handleSend(text: string) {
    // The composer is already disabled in every refusal window; this guard just
    // keeps a stale `error` from being re-toasted if one slips through.
    if (chat.busy) return;
    const beforeId = chat.session?.id ?? null;
    const needsCreate = beforeId === null || chat.status === "ended";

    await chat.prompt(text);

    // A create that failed leaves the session unchanged and the message in
    // `chat.error` — the strip shows it, but a toast is what gets noticed when
    // the panel is otherwise empty.
    if (needsCreate && chat.error !== null && (chat.session?.id ?? null) === beforeId) {
      toast.error("Couldn't start the session", { description: chat.error });
    }
  }
</script>

<div class="flex h-full min-h-[320px] flex-col overflow-hidden rounded-lg border bg-background">
  <div class="shrink-0 border-b px-3 py-2">
    <ChatHeader
      session={chat.session}
      status={chat.status}
      connection={chat.connection}
      mode={chat.mode}
      onModeChange={(mode) => chat.setMode(mode)}
      onEnd={() => {
        // While disconnected the DELETE still lands, but the ended state
        // arrives over the event stream — the strip keeps saying "disconnected"
        // until a retry reconnects and replays it. That's the honest reading.
        void chat.end();
      }}
      onNew={() => chat.newSession()}
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
    <PromptInput
      bind:value={draft}
      working={chat.working}
      disabled={chat.busy && !chat.working}
      onSend={handleSend}
      onCancel={() => chat.cancel()}
    />
  </div>
</div>
