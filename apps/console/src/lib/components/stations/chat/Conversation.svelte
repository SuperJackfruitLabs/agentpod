<script lang="ts">
  /**
   * Conversation — the chat transcript list with follow-tail mechanics.
   *
   * Renders ChatItems by kind and keeps the viewport pinned to the newest
   * message while the reader is at (or near) the bottom — the same follow
   * model as LogTail: scrolling >40px away pauses follow and new arrivals
   * count into a floating "N new messages" pill; scrolling back down (or
   * clicking the pill) re-engages. Streaming growth of the trailing
   * assistant/reasoning item also holds the pin while following.
   *
   * Items are keyed by stable identity (toolCallId / requestSeq / seq) so
   * Svelte reuses component instances correctly — ToolCallCard and Reasoning
   * carry edge-triggered collapse state that unkeyed reuse would corrupt.
   *
   * An sr-only polite live region announces new permission requests
   * ("Agent asks to <title>") and working/idle/ended status flips.
   */
  import { onDestroy } from "svelte";
  import type { AcpSessionStatus } from "@agentpod/contract";
  import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";
  import MessageSquareIcon from "@lucide/svelte/icons/message-square";
  import { Empty } from "$lib/components/ui/empty";
  import { cn } from "$lib/utils";
  import Response from "./Response.svelte";
  import Reasoning from "./Reasoning.svelte";
  import ToolCallCard from "./ToolCallCard.svelte";
  import PermissionCard from "./PermissionCard.svelte";
  import type { ChatItem } from "./transcript";

  interface Props {
    items: ChatItem[];
    status: AcpSessionStatus;
    onAnswer: (requestSeq: number, optionId: string) => void;
  }

  let { items, status, onAnswer }: Props = $props();

  /** Stable identity per item — tool/permission items mutate in place across
   * folds (status updates, answers) and streaming items grow, so the key must
   * come from their identity, never the array index or object reference. */
  function keyOf(item: ChatItem): string {
    if (item.kind === "tool") return `tool:${item.toolCallId}`;
    if (item.kind === "permission") return `permission:${item.requestSeq}`;
    return `${item.kind}:${item.seq}`;
  }

  // ── Follow-tail (mirrors LogTail) ─────────────────────────────────────────
  const FOLLOW_THRESHOLD_PX = 40;

  let containerEl = $state<HTMLElement | null>(null);
  let follow = $state(true);
  let newItemsCount = $state(0);
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;

  function queueScrollToBottom() {
    if (scrollTimer !== null) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      if (containerEl) containerEl.scrollTop = containerEl.scrollHeight;
    }, 0);
  }

  // A manual scroll away from the bottom (>~40px) pauses follow; scrolling
  // back to within the threshold re-enables it.
  function handleScroll() {
    if (!containerEl) return;
    const distanceFromBottom =
      containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight;
    if (distanceFromBottom > FOLLOW_THRESHOLD_PX) {
      follow = false;
    } else {
      follow = true;
      newItemsCount = 0;
    }
  }

  function jumpToBottom() {
    follow = true;
    newItemsCount = 0;
    queueScrollToBottom();
  }

  // Growth detection: new items scroll (following) or count into the pill
  // (paused); trailing-item TEXT growth (a streaming chunk that extends the
  // last item without appending one) also scrolls while following. Plain lets
  // hold the previous frame — they must never retrigger the effect.
  let prevCount = 0;
  let prevTailLen = 0;
  $effect(() => {
    const count = items.length;
    const tail = items.at(-1);
    const tailLen =
      tail && (tail.kind === "assistant" || tail.kind === "reasoning") ? tail.text.length : 0;
    const added = count - prevCount;
    const tailGrew = added === 0 && tailLen > prevTailLen;
    prevCount = count;
    prevTailLen = tailLen;

    if (added > 0) {
      if (follow) queueScrollToBottom();
      else newItemsCount += added;
    } else if (added < 0) {
      // Transcript replaced (new session) — reset the pill.
      newItemsCount = 0;
    } else if (tailGrew && follow) {
      queueScrollToBottom();
    }
  });

  onDestroy(() => {
    if (scrollTimer !== null) {
      clearTimeout(scrollTimer);
      scrollTimer = null;
    }
  });

  // ── Screen-reader announcements ───────────────────────────────────────────
  const STATUS_ANNOUNCEMENTS: Partial<Record<AcpSessionStatus, string>> = {
    working: "Agent is working.",
    idle: "Agent is idle.",
    ended: "Session ended.",
  };

  let announcement = $state("");
  let announcedPermSeq: number | null = null;
  let prevStatus: AcpSessionStatus | null = null;

  // A newly arrived permission request (including one already parked when the
  // transcript mounts) is the most actionable thing in the stream — announce.
  $effect(() => {
    const perm = items.findLast(
      (it): it is Extract<ChatItem, { kind: "permission" }> => it.kind === "permission",
    );
    if (perm && perm.requestSeq !== announcedPermSeq) {
      announcedPermSeq = perm.requestSeq;
      announcement = `Agent asks to ${perm.title}`;
    }
  });

  // Status FLIPS only — the initial value is visible in the header already.
  $effect(() => {
    const s = status;
    if (prevStatus !== null && s !== prevStatus) {
      const msg = STATUS_ANNOUNCEMENTS[s];
      if (msg) announcement = msg;
    }
    prevStatus = s;
  });
</script>

<div class="relative h-full min-h-0">
  <div
    bind:this={containerEl}
    data-testid="chat-scroll-container"
    class="h-full overflow-y-auto"
    onscroll={handleScroll}
  >
    {#if items.length === 0}
      <Empty
        title="No conversation yet."
        description="Send a prompt to start talking to this agent."
        icon={MessageSquareIcon}
        class="h-full border-none"
      />
    {:else}
      <div class="flex flex-col gap-3 p-3">
        {#each items as item (keyOf(item))}
          <div class="chat-item">
            {#if item.kind === "user"}
              <div class="flex justify-end">
                <div
                  class={cn(
                    "t-body max-w-[85%] rounded-lg bg-primary/10 px-3 py-2 whitespace-pre-wrap break-words",
                    item.pending && "opacity-60",
                  )}
                >
                  {item.text}
                </div>
              </div>
            {:else if item.kind === "assistant"}
              <Response text={item.text} streaming={item.streaming} />
            {:else if item.kind === "reasoning"}
              <Reasoning text={item.text} streaming={item.streaming} />
            {:else if item.kind === "tool"}
              <ToolCallCard {item} />
            {:else if item.kind === "permission"}
              <PermissionCard
                {item}
                onAnswer={(optionId) => onAnswer(item.requestSeq, optionId)}
              />
            {:else if item.kind === "notice"}
              <p
                class={cn(
                  "t-label text-center",
                  item.level === "error" ? "text-status-error" : "text-muted-foreground",
                )}
              >
                {item.text}
              </p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if !follow && newItemsCount > 0}
    <button
      type="button"
      class="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full border bg-background px-3 py-1 text-xs shadow-md hover:bg-muted"
      onclick={jumpToBottom}
    >
      {newItemsCount} new {newItemsCount === 1 ? "message" : "messages"}
      <ArrowDownIcon class="size-3" aria-hidden="true" />
    </button>
  {/if}

  <div data-testid="chat-announcer" aria-live="polite" class="sr-only">{announcement}</div>
</div>

<style>
  /* Long transcripts: skip layout/paint for offscreen items. The intrinsic
     placeholder keeps scrollbar geometry sane before an item is rendered. */
  .chat-item {
    content-visibility: auto;
    contain-intrinsic-size: auto 4rem;
  }
</style>
