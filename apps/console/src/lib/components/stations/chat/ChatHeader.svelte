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
   *
   * The PREAMBLE row is session metadata, not conversation: harnesses that
   * announce themselves before anyone has spoken (pi prints its version and
   * loaded skills on stdout before the protocol stream starts) used to have
   * that banner rendered as the first agent message. It belongs here, collapsed
   * to its first line and expandable — and when there is none, nothing is
   * rendered at all rather than an empty affordance. It is deliberately outside
   * the status region: metadata is not an announcement.
   */
  import type { AcpSessionMode, AcpSessionStatus } from "@agentpod/contract";
  import type { AcpSessionRow } from "$lib/api/acp";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import type { ChatConnection } from "./acp-chat.svelte";
  import type { SessionPreamble } from "./transcript";
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import * as Select from "$lib/components/ui/select";
  import { Status } from "$lib/components/ui/status";
  import { chipClass } from "$lib/utils/toggle-chip";
  import { relativeTime } from "$lib/utils/relative-time";
  import { ACP_STATUS_TOKEN, sessionName, untitledSessionLabel } from "./session-status";

  interface Props {
    session: AcpSessionRow | null;
    /** Every session on the station, in the hub's order (newest activity first). */
    sessions: AcpSessionRow[];
    /** The one on screen — normally `session.id`, or the pick being attached. */
    selectedId: string | null;
    status: AcpSessionStatus;
    connection: ChatConnection;
    mode: AcpSessionMode;
    /**
     * Whatever the agent said before the user's first prompt (the harness
     * banner), or null when it said nothing — then no row is rendered.
     */
    preamble?: SessionPreamble | null;
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
    preamble = null,
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
   * A session's title, or "Session N" (numbered by creation order across
   * `sessions`) until its first prompt gives it one — the shared fallback
   * from session-status.ts, so the history dialog names the same row the
   * same way.
   */
  function nameOf(s: AcpSessionRow): string {
    return sessionName(s, untitledSessionLabel(sessions, s.id));
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

  /**
   * The preamble disclosure. Collapsed by default — it is reference material,
   * and the whole point of moving it out of the transcript was that it stopped
   * being the first thing you read.
   */
  let preambleOpen = $state(false);
</script>

<div class="flex flex-col gap-1.5">
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

    <div class="ml-auto flex items-center gap-1">
      {#if session}
        {#if status !== "ended"}
          <Button variant="ghost" size="sm" onclick={() => (confirmEndOpen = true)}>
            End session
          </Button>
        {/if}
        <Button
          variant="outline"
          size="sm"
          data-testid="chat-new-session"
          disabled={creating}
          onclick={onNew}
        >
          {creating ? "Starting…" : "New session"}
        </Button>
      {:else}
        <!--
          A station with no session used to render no button at all, because this
          whole group sat inside `{#if session}`. The only way to start one was to
          send a message — `prompt()` creates a session when none is attached — so
          the very first message silently paid for it. That is not cheap: against
          the live fleet the create POST takes 5-7 seconds while the node spawns
          the agent's ACP process. The wait is the same either way; what was
          missing was any way to spend it BEFORE typing.
        -->
        <Button
          variant="outline"
          size="sm"
          data-testid="chat-start-session"
          disabled={creating}
          onclick={onNew}
        >
          {creating ? "Starting…" : "Start session"}
        </Button>
      {/if}
    </div>
  </div>

  <!-- Session metadata, not conversation. Rendered ONLY when the agent actually
       said something before the first prompt — an empty disclosure would be a
       permanent affordance for nothing. The purpose lives in the trigger's
       aria-label because the visible text is the banner's own first line, which
       says nothing about what it is. -->
  {#if preamble}
    <Collapsible.Root bind:open={preambleOpen}>
      <div data-testid="session-preamble" class="min-w-0">
        <Collapsible.Trigger
          class="group flex min-w-0 max-w-full items-center gap-1.5 rounded-sm py-0.5 text-left text-muted-foreground hover:text-foreground"
          aria-label={preamble.more > 0
            ? `Agent startup output — ${preamble.summary}, ${preamble.more} more ${preamble.more === 1 ? "line" : "lines"}`
            : `Agent startup output — ${preamble.summary}`}
        >
          <ChevronDownIcon
            class="size-3 shrink-0 transition-transform motion-reduce:transition-none group-data-[state=closed]:-rotate-90"
            aria-hidden="true"
          />
          <span class="t-label truncate font-mono">{preamble.summary}</span>
          {#if preamble.more > 0}
            <span class="t-label shrink-0 opacity-70">
              +{preamble.more}
              {preamble.more === 1 ? "line" : "lines"}
            </span>
          {/if}
        </Collapsible.Trigger>
        <Collapsible.Content>
          <!-- Verbatim, so a path or a version string is copyable as printed;
               capped and scrollable so a chatty harness can't push the
               transcript off the panel. -->
          <pre
            data-testid="session-preamble-text"
            class="t-label mt-1 max-h-40 overflow-auto border-l-2 border-border pl-3 font-mono break-words whitespace-pre-wrap text-muted-foreground">{preamble.text}</pre>
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
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
