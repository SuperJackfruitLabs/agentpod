<script lang="ts">
  /**
   * PermissionCard — an agent permission request in the transcript.
   *
   * Unanswered: pulsing "awaiting approval" dot, mono title, and one real
   * <Button> per agent-supplied option — the first allow* option is the
   * primary action, other allow* are secondary, reject* render as outline.
   * There is deliberately NO extra dismiss affordance: agents supply reject
   * options themselves, and whole-turn cancellation is the session
   * controller's cancel(), not this card's concern.
   *
   * Answered: muted record of what was chosen ("· auto" when auto-answered
   * by mode, "Cancelled." when the request was cancelled) with no buttons.
   */
  import { Status } from "$lib/components/ui/status";
  import { Button, type ButtonVariant } from "$lib/components/ui/button";
  import type { ChatItem } from "./transcript";

  interface Props {
    item: Extract<ChatItem, { kind: "permission" }>;
    onAnswer: (optionId: string) => void;
  }

  let { item, onAnswer }: Props = $props();

  const answer = $derived(item.answer);
  const firstAllowId = $derived(
    item.options.find((o) => o.kind.startsWith("allow"))?.optionId,
  );

  function variantFor(option: { optionId: string; kind: string }): ButtonVariant {
    if (option.kind.startsWith("allow")) {
      return option.optionId === firstAllowId ? "default" : "secondary";
    }
    return "outline";
  }

  const chosenName = $derived(
    item.options.find((o) => o.optionId === answer?.optionId)?.name ??
      answer?.optionId ??
      "Answered",
  );
</script>

{#if !answer}
  <div class="rounded-lg border border-border p-3">
    <div class="flex items-center gap-2">
      <Status form="dot" status="starting" animate label="awaiting approval" />
      <span class="min-w-0 truncate font-mono text-sm">{item.title}</span>
      {#if item.toolKind}
        <span class="t-label shrink-0">{item.toolKind}</span>
      {/if}
    </div>
    <div class="mt-2 flex flex-wrap gap-2">
      {#each item.options as option (option.optionId)}
        <Button size="sm" variant={variantFor(option)} onclick={() => onAnswer(option.optionId)}>
          {option.name}
        </Button>
      {/each}
    </div>
  </div>
{:else}
  <div class="rounded-lg border border-border/60 p-3 text-muted-foreground">
    <div class="flex items-center gap-2">
      <span class="min-w-0 truncate font-mono text-sm">{item.title}</span>
      {#if item.toolKind}
        <span class="t-label shrink-0">{item.toolKind}</span>
      {/if}
    </div>
    <p class="t-body mt-1">
      {#if answer.cancelled}Cancelled.{:else}{chosenName}{#if answer.auto}
        · auto{/if}{/if}
    </p>
  </div>
{/if}
