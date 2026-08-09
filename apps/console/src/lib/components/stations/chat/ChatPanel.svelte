<script lang="ts">
  /**
   * ChatPanel — the station's Chat tab: one AcpChat session controller wired to
   * the header (status/mode/session actions), the transcript, and the composer.
   *
   * Sizing mirrors Terminal.svelte: a full-height bordered column whose middle
   * row (the transcript) is the only scroller — `flex-1 min-h-0` so a long
   * conversation never pushes the composer off screen.
   *
   * The controller owns every refusal rule; the panel's job is to never let the
   * user lose text to one. `chat.busy` is true exactly when `prompt()` would
   * refuse (create in flight / optimistic prompt awaiting its echo / agent
   * working), and PromptInput only preserves a draft it wasn't allowed to send —
   * so `busy` must reach it as `working` (mid-turn, where Stop is the action) or
   * `disabled` (the create + echo window).
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

  // Plain (non-reactive) ref: the controller holds its own $state internally,
  // so the template stays reactive while the instance itself is stable for the
  // lifetime of the panel. The station is fixed at construction on purpose —
  // the station page keys this panel on `stationId`, so a different station
  // gets a fresh panel (and a fresh socket) rather than a rebound controller.
  // svelte-ignore state_referenced_locally
  let chat = new AcpChat(stationId);

  onMount(() => {
    void chat.init();
    // Unmount (including a tab switch that drops this panel) closes the socket
    // only — the session keeps running on the hub and is re-attached on return.
    return () => chat.destroy();
  });

  /**
   * Session status shown to the user. The transcript's status is stream truth
   * (working → idle → ended) but starts at the `"starting"` placeholder, which
   * an attached session that hasn't emitted a state event yet would sit on
   * forever — so until the stream says otherwise, the session row's own status
   * wins.
   */
  const status = $derived(
    chat.transcript.status === "starting" && chat.session
      ? chat.session.status
      : chat.transcript.status,
  );

  async function handleSend(text: string) {
    // The composer is already disabled in every refusal window; this guard just
    // keeps a stale `error` from being re-toasted if one slips through.
    if (chat.busy) return;
    const beforeId = chat.session?.id ?? null;
    const needsCreate = beforeId === null || chat.transcript.status === "ended";

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
      {status}
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
      {status}
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
      working={chat.working}
      disabled={chat.busy && !chat.working}
      onSend={handleSend}
      onCancel={() => chat.cancel()}
    />
  </div>
</div>
