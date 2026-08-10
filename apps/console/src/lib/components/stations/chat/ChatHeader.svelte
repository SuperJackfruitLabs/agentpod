<script lang="ts">
  /**
   * ChatHeader — session status, permission-mode selector, session actions.
   *
   * Status maps the ACP session vocab onto the console's shared status
   * tokens (working→starting+pulse, idle→running, waiting→degraded,
   * ended→stopped). Transport state overrides the label — while connecting,
   * replaying or reconnecting the session state is not yet trustworthy, and it
   * is also why the composer refuses to send, so the user gets told.
   *
   * This is the ONE live region for session status in the panel: Conversation
   * announces permissions only, so a flip is never read out twice. The session
   * switcher below deliberately adds none — it is a control, not an
   * announcement, and a second region would read every flip twice.
   *
   * The switcher appears only once the station has MORE than one session: with
   * one there is nothing to switch to, and an inert control beside the status
   * line would be noise. Rows are rendered in the order the hub gave them
   * (newest-activity-first) — never re-sorted here, or the list would reshuffle
   * under the pointer. Each row is numbered by creation order so two sessions
   * that happen to share a status and a rounded age are still tellable apart.
   *
   * "New session" is offered whatever the current session's status: a station
   * can host several at once, so starting another is not something to wait for
   * the current one to end. It is disabled only while a create is in flight.
   *
   * Mode chips are never disabled: pre-session the selection seeds creation,
   * live it round-trips set-mode, and after end it seeds the next session
   * (AcpChat.setMode handles all three).
   *
   * Ending a session is destructive (the agent process stops) — gated behind
   * ConfirmDialog. "New session" sits beside it and is offered whatever the
   * status; only "End session" disappears once there is nothing left to end.
   */
  import type { AcpSessionMode, AcpSessionStatus } from "@agentpod/contract";
  import type { AcpSessionRow } from "$lib/api/acp";
  import type { ChatConnection } from "./acp-chat.svelte";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import * as Select from "$lib/components/ui/select";
  import { Status } from "$lib/components/ui/status";
  import { chipClass } from "$lib/utils/toggle-chip";
  import { relativeTime } from "$lib/utils/relative-time";

  interface Props {
    session: AcpSessionRow | null;
    /** Every session on the station, in the hub's order (newest activity first). */
    sessions: AcpSessionRow[];
    /** The one on screen — normally `session.id`, or the pick being attached. */
    selectedId: string | null;
    status: AcpSessionStatus;
    connection: ChatConnection;
    mode: AcpSessionMode;
    /** True while a create POST is in flight (disables "New session"). */
    creating?: boolean;
    onModeChange: (mode: AcpSessionMode) => void;
    onEnd: () => void;
    onNew: () => void;
    onSelectSession: (sessionId: string) => void;
  }

  let {
    session,
    sessions,
    selectedId,
    status,
    connection,
    mode,
    creating = false,
    onModeChange,
    onEnd,
    onNew,
    onSelectSession,
  }: Props = $props();

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

  /** Transport is still catching up: the transcript (and status) is incomplete. */
  const syncing = $derived(connection === "connecting" || connection === "reconnecting");

  const dotStatus = $derived(
    syncing ? "starting" : connection === "disconnected" ? "error" : session ? STATUS_DOT[status] : "stopped",
  );
  const dotAnimate = $derived(
    syncing || (connection !== "disconnected" && status === "working"),
  );
  const label = $derived(
    connection === "connecting"
      ? "Connecting…"
      : connection === "reconnecting"
        ? "Reconnecting…"
        : connection === "disconnected"
          ? "Disconnected"
          : session
            ? STATUS_LABEL[status]
            : "No session",
  );

  /**
   * id → "Session N", numbered by creation order. Computed from a SORTED COPY:
   * the rendered list keeps the hub's activity order, only the numbers come from
   * createdAt, so a session's name never changes as it streams.
   */
  const sessionNumber = $derived.by(() => {
    const byAge = [...sessions].sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    );
    return new Map(byAge.map((s, i) => [s.id, i + 1]));
  });

  /** "Session 2 · working · 5m ago" — status stays lowercase (agent-reported data). */
  function sessionLabel(s: AcpSessionRow): string {
    return `Session ${sessionNumber.get(s.id) ?? "?"} · ${s.status} · ${relativeTime(s.lastEventAt)}`;
  }

  const selectedRow = $derived(sessions.find((s) => s.id === selectedId) ?? session);

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

  {#if sessions.length > 1}
    <Select.Root
      type="single"
      value={selectedId ?? ""}
      onValueChange={(v) => {
        // bits-ui re-fires for the value already selected; re-attaching there
        // would tear down the socket the user is looking at.
        if (v && v !== selectedId) onSelectSession(v);
      }}
    >
      <Select.Trigger
        size="sm"
        class="min-w-0 max-w-56"
        aria-label={selectedRow
          ? `Switch session — currently ${sessionLabel(selectedRow)}`
          : "Switch session"}
      >
        <!-- aria-hidden: the label carries the status word, so the dot's own
             sr-only text would read as a duplicate. -->
        {#if selectedRow}
          <span aria-hidden="true" class="flex">
            <Status form="dot" status={STATUS_DOT[selectedRow.status]} />
          </span>
          <span class="truncate">{sessionLabel(selectedRow)}</span>
        {:else}
          <span class="truncate">Sessions</span>
        {/if}
      </Select.Trigger>
      <Select.Content>
        {#each sessions as s (s.id)}
          <Select.Item value={s.id}>
            <span aria-hidden="true" class="flex">
              <Status form="dot" status={STATUS_DOT[s.status]} />
            </span>
            <span>{sessionLabel(s)}</span>
          </Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  {/if}

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
    <div class="ml-auto flex items-center gap-1">
      {#if status !== "ended"}
        <Button variant="ghost" size="sm" onclick={() => (confirmEndOpen = true)}>
          End session
        </Button>
      {/if}
      <Button variant="outline" size="sm" disabled={creating} onclick={onNew}>New session</Button>
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
