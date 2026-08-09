<script lang="ts">
  /**
   * ChatHeader — session status, permission-mode selector, session actions.
   *
   * Status maps the ACP session vocab onto the console's shared status
   * tokens (working→starting+pulse, idle→running, waiting→degraded,
   * ended→stopped). A degraded CONNECTION (reconnecting/disconnected)
   * overrides the label — transport truth beats stale session state.
   *
   * Mode chips are never disabled: pre-session the selection seeds creation,
   * live it round-trips set-mode, and after end it seeds the next session
   * (AcpChat.setMode handles all three).
   *
   * Ending a session is destructive (the agent process stops) — gated behind
   * ConfirmDialog. An ended session flips the action to "New session".
   */
  import type { AcpSessionMode, AcpSessionStatus } from "@agentpod/contract";
  import type { AcpSessionRow } from "$lib/api/acp";
  import type { ChatConnection } from "./acp-chat.svelte";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import { Status } from "$lib/components/ui/status";
  import { chipClass } from "$lib/utils/toggle-chip";

  interface Props {
    session: AcpSessionRow | null;
    status: AcpSessionStatus;
    connection: ChatConnection;
    mode: AcpSessionMode;
    onModeChange: (mode: AcpSessionMode) => void;
    onEnd: () => void;
    onNew: () => void;
  }

  let { session, status, connection, mode, onModeChange, onEnd, onNew }: Props = $props();

  const STATUS_DOT: Record<AcpSessionStatus, string> = {
    starting: "starting",
    working: "starting",
    idle: "running",
    waiting: "degraded",
    ended: "stopped",
  };
  const STATUS_LABEL: Record<AcpSessionStatus, string> = {
    starting: "Starting…",
    working: "Working…",
    idle: "Idle",
    waiting: "Waiting for approval",
    ended: "Ended",
  };

  const MODES: Array<{ value: AcpSessionMode; label: string }> = [
    { value: "ask", label: "Ask" },
    { value: "accept-edits", label: "Accept edits" },
    { value: "full-auto", label: "Full auto" },
  ];

  const dotStatus = $derived(
    connection === "reconnecting"
      ? "starting"
      : connection === "disconnected"
        ? "error"
        : session
          ? STATUS_DOT[status]
          : "stopped",
  );
  const dotAnimate = $derived(
    connection === "reconnecting" || (connection !== "disconnected" && status === "working"),
  );
  const label = $derived(
    connection === "reconnecting"
      ? "Reconnecting…"
      : connection === "disconnected"
        ? "Disconnected"
        : session
          ? STATUS_LABEL[status]
          : "No session",
  );

  let confirmEndOpen = $state(false);
</script>

<div class="flex flex-wrap items-center gap-3">
  <div role="status" aria-live="polite" class="flex min-w-0 items-center gap-2">
    <!-- aria-hidden: the visible label is the ONE accessible text; the dot's
         built-in sr-only label would read as a duplicate. -->
    <span aria-hidden="true" class="flex">
      <Status form="dot" status={dotStatus} animate={dotAnimate} {label} />
    </span>
    <span class="t-label truncate">{label}</span>
  </div>

  <div role="group" aria-label="Permission mode" class="flex items-center gap-1 text-xs">
    {#each MODES as m (m.value)}
      <button
        type="button"
        class={chipClass(mode === m.value)}
        aria-pressed={mode === m.value}
        onclick={() => onModeChange(m.value)}
      >
        {m.label}
      </button>
    {/each}
  </div>

  {#if session}
    <div class="ml-auto">
      {#if status === "ended"}
        <Button variant="outline" size="sm" onclick={onNew}>New session</Button>
      {:else}
        <Button variant="ghost" size="sm" onclick={() => (confirmEndOpen = true)}>
          End session
        </Button>
      {/if}
    </div>
  {/if}
</div>

<ConfirmDialog
  open={confirmEndOpen}
  title="End this session?"
  message="The agent process stops and the transcript is kept."
  confirmLabel="End session"
  destructive
  onConfirm={() => {
    confirmEndOpen = false;
    onEnd();
  }}
  onCancel={() => (confirmEndOpen = false)}
/>
