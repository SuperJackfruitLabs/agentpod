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
   *
   * `disabled` never reaches the textarea as the `disabled` attribute: the
   * caller sets it in the window right after a send (session create + optimistic
   * echo), and a focused element that becomes `disabled` is blurred to <body> by
   * the browser — every turn would throw a keyboard user back to the top of the
   * transcript. It's `aria-disabled` + `readonly` instead, so focus survives,
   * and `send()`'s own guard (not the attribute) is what refuses the send and
   * keeps the draft.
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
    class="max-h-40 min-h-9 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
    aria-disabled={disabled ? "true" : undefined}
    readonly={disabled}
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
