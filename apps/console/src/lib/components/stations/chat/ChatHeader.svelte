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
   * under the pointer. A row is named by its TITLE (the session's first prompt)
   * and falls back to "Session N" numbered by creation order, so two untitled
   * sessions sharing a status and a rounded age are still tellable apart.
   *
   * The switcher is a shortcut, not an archive: it shows at most SWITCHER_LIMIT
   * sessions and, when the station has more, ends with an "All sessions…" row
   * that opens the history dialog. An uncapped dropdown of every session a
   * station ever hosted is unusable, and history is the surface built for scale.
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
  import { ACP_STATUS_TOKEN, sessionName } from "./session-status";

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
    /** Opens the full (paginated) session history — the switcher's escape hatch. */
    onOpenHistory: () => void;
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
    onOpenHistory,
  }: Props = $props();

  /** Shared with the history dialog, so a session is never two colours at once. */
  const STATUS_DOT = ACP_STATUS_TOKEN;
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

  /** A session's title, or "Session N" until its first prompt gives it one. */
  function nameOf(s: AcpSessionRow): string {
    return sessionName(s, `Session ${sessionNumber.get(s.id) ?? "?"}`);
  }

  /** The row's meta half: "· working · 5m ago" (status is agent data → lowercase). */
  function metaOf(s: AcpSessionRow): string {
    return `· ${s.status} · ${relativeTime(s.lastEventAt)}`;
  }

  /**
   * "Fix the flaky test · working · 5m ago" — the row's whole accessible name.
   * Set explicitly (aria-label) because the visible row is split into a
   * truncating name and a meta span, and an accessible name assembled from
   * separate elements is at the mercy of how the browser joins them.
   */
  function sessionLabel(s: AcpSessionRow): string {
    return `${nameOf(s)} ${metaOf(s)}`;
  }

  const selectedRow = $derived(sessions.find((s) => s.id === selectedId) ?? session);

  /** How many sessions the dropdown itself will show. Beyond it: history. */
  const SWITCHER_LIMIT = 8;
  /** Sentinel value for the "All sessions…" row — never a real session id. */
  const ALL_SESSIONS = "__all-sessions__";

  const visibleSessions = $derived.by(() => {
    const head = sessions.slice(0, SWITCHER_LIMIT);
    // The session ON SCREEN is always in the list, even when its activity has
    // sunk past the cap (opening an old one from history does exactly that) — a
    // switcher that can't show what you are reading looks like a lost pick.
    const current = selectedRow;
    return current && !head.some((s) => s.id === current.id) ? [...head, current] : head;
  });
  const hasMoreSessions = $derived(sessions.length > SWITCHER_LIMIT);

  /**
   * The value bits-ui holds. Mirrors the pick, but it is local state because
   * "All sessions…" is a COMMAND, not a value: it is reverted the moment it
   * fires, or the checkmark would sit next to it instead of the session that is
   * actually on screen.
   */
  let selectValue = $state("");
  $effect(() => {
    // The panel's pick is authoritative — including when a switch was refused
    // and `selectedId` stayed where it was. (Seeded here rather than at
    // declaration so the prop is tracked, not captured once.)
    selectValue = selectedId ?? "";
  });

  function handleValueChange(v: string): void {
    if (v === ALL_SESSIONS) {
      selectValue = selectedId ?? "";
      onOpenHistory();
      return;
    }
    // bits-ui re-fires for the value already selected; re-attaching there
    // would tear down the socket the user is looking at.
    if (v && v !== selectedId) onSelectSession(v);
  }

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
    <Select.Root type="single" bind:value={selectValue} onValueChange={handleValueChange}>
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
      <Select.Content class="max-w-[calc(100vw-2rem)]">
        {#each visibleSessions as s (s.id)}
          <!-- aria-label: the row is two spans (a truncating name + its meta), so
               the accessible name is stated once, verbatim, instead of being
               reassembled from them. -->
          <Select.Item value={s.id} aria-label={sessionLabel(s)}>
            <span aria-hidden="true" class="flex">
              <Status form="dot" status={STATUS_DOT[s.status]} />
            </span>
            <!-- min-w-0 + truncate: a title is up to 80 chars of the user's own
                 prose and must not stretch the dropdown across the viewport. -->
            <span class="min-w-0 max-w-64 truncate">{nameOf(s)}</span>
            <span class="shrink-0 text-muted-foreground">{metaOf(s)}</span>
          </Select.Item>
        {/each}
        {#if hasMoreSessions}
          <!-- Not a session: picking it opens history (handleValueChange reverts
               the value straight away). It lives INSIDE the listbox so it is
               reachable by keyboard like every other row. -->
          <Select.Item value={ALL_SESSIONS} aria-label="All sessions…">
            <span class="truncate">All sessions…</span>
          </Select.Item>
        {/if}
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
