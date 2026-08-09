<script lang="ts">
  /**
   * PromptInput — the chat composer.
   *
   * Enter sends the trimmed draft (IME-safe: composition Enter is ignored),
   * Shift+Enter inserts a newline, and the box clears only when a send
   * actually happens. While the agent is working the send button becomes a
   * stop button (cancel the turn) and Enter is a no-op that KEEPS the draft —
   * the controller refuses mid-turn prompts, so silently clearing would lose
   * the user's text.
   */
  import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
  import SquareIcon from "@lucide/svelte/icons/square";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";

  interface Props {
    disabled?: boolean;
    working: boolean;
    onSend: (text: string) => void;
    onCancel: () => void;
  }

  let { disabled = false, working, onSend, onCancel }: Props = $props();

  let value = $state("");
  const canSend = $derived(value.trim().length > 0);

  function send() {
    const text = value.trim();
    if (!text || disabled || working) return;
    onSend(text);
    value = "";
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    send();
  }
</script>

<div class="flex items-end gap-2">
  <Textarea
    bind:value
    placeholder="Message the agent…"
    aria-label="Message the agent"
    class="max-h-40 min-h-9"
    {disabled}
    onkeydown={handleKeydown}
  />
  {#if working}
    <Button
      variant="outline"
      size="icon-sm"
      aria-label="Stop the current turn"
      onclick={onCancel}
    >
      <SquareIcon class="size-3 fill-current" aria-hidden="true" />
    </Button>
  {:else}
    <Button size="icon-sm" aria-label="Send" disabled={disabled || !canSend} onclick={send}>
      <ArrowUpIcon aria-hidden="true" />
    </Button>
  {/if}
</div>
