<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { logsUrl } from "$lib/api/client";
  import { Button } from "$lib/components/ui/button";
  import { Empty } from "$lib/components/ui/empty";
  import { cn } from "$lib/utils";
  import { chipClass } from "$lib/utils/toggle-chip";
  import { statusTextClass } from "$lib/utils/status-badge";
  import SearchIcon from "@lucide/svelte/icons/search";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";

  interface Props {
    stationId: string;
  }

  let { stationId }: Props = $props();

  // ── Line model ────────────────────────────────────────────────────────────
  // Each line is classified exactly once, on arrival — never per render.
  type Level = "error" | "warn" | "info" | null;
  interface LogLine {
    raw: string;
    text: string;
    level: Level;
  }

  // Maximum number of log lines kept in the buffer at any time.
  // Older lines are dropped when new ones push past this cap.
  const MAX_LINES = 10_000;

  // ESC control char built via String.fromCharCode so no raw ESC byte lives
  // in source (editors/diffs mangle literal escape bytes).
  const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
  const ERROR_RE = /\b(ERROR|ERR|FATAL)\b/i;
  const WARN_RE = /\b(WARN|WARNING)\b/i;
  const INFO_RE = /\b(INFO|NOTICE)\b/i;

  function classify(raw: string): LogLine {
    const text = raw.replace(ANSI_RE, "");
    let level: Level = null;
    if (ERROR_RE.test(text)) level = "error";
    else if (WARN_RE.test(text)) level = "warn";
    else if (INFO_RE.test(text)) level = "info";
    return { raw, text, level };
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────
  type Status = "connecting" | "connected" | "reconnecting" | "closed";
  const BACKOFF_MS = [1000, 2000, 4000, 8000];
  const MAX_ATTEMPTS = 5;

  let status = $state<Status>("connecting");
  let attempt = 0; // reconnect attempts made since the last successful open
  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function connect() {
    clearReconnectTimer();
    if (typeof EventSource === "undefined") {
      // jsdom / non-browser environments without an EventSource polyfill.
      status = "closed";
      return;
    }

    status = attempt === 0 ? "connecting" : "reconnecting";

    const url = logsUrl(stationId);
    // withCredentials so the Better Auth session cookie is sent on the
    // cross-origin SSE request (console :1420 → hub :3001); without it the
    // /logs endpoint returns 401.
    es = new EventSource(url, { withCredentials: true });

    es.onopen = () => {
      attempt = 0;
      status = "connected";
    };

    es.onmessage = (event: MessageEvent) => {
      handleLine(event.data as string);
    };

    es.onerror = () => {
      es?.close();
      es = null;
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (attempt >= MAX_ATTEMPTS) {
      status = "closed";
      return;
    }
    status = "reconnecting";
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function retryNow() {
    attempt = 0;
    connect();
  }

  // ── Buffer + follow-tail ─────────────────────────────────────────────────
  let lines = $state<LogLine[]>([]);
  let follow = $state(true);
  let newLinesCount = $state(0);
  let containerEl = $state<HTMLElement | null>(null);
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;

  // Incoming SSE messages can arrive in tight synchronous bursts (a fast
  // reconnect replaying thousands of buffered lines). Copying `lines` and
  // re-running the filter/count deriveds on every single message is O(n²)
  // over a burst. Instead, land each line in a plain (non-reactive) array
  // and flush the batch into the reactive `lines` at most once per
  // FLUSH_INTERVAL_MS — one array copy and one derived recompute per flush,
  // not per message. The first message after an idle period flushes
  // immediately (leading edge) so a single trickling line still shows up
  // right away; a trailing timer then coalesces whatever arrives during the
  // following window.
  const FLUSH_INTERVAL_MS = 50;
  let pendingLines: LogLine[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushPending() {
    if (pendingLines.length === 0) return;
    const batch = pendingLines;
    pendingLines = [];

    const next = [...lines, ...batch];
    lines = next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;

    if (follow) {
      queueScrollToBottom();
    } else {
      newLinesCount += batch.length;
    }
  }

  function handleLine(raw: string) {
    pendingLines.push(classify(raw));

    if (flushTimer === null) {
      // Idle → flush this line right away, then hold the gate open for
      // FLUSH_INTERVAL_MS so anything else that arrives in that window
      // (including further lines pushed synchronously by the caller, e.g.
      // a burst) lands in a single trailing flush.
      flushPending();
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPending();
      }, FLUSH_INTERVAL_MS);
    }
  }

  function queueScrollToBottom() {
    if (scrollTimer !== null) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      if (containerEl) containerEl.scrollTop = containerEl.scrollHeight;
    }, 0);
  }

  // A manual scroll away from the bottom (>~40px) pauses follow; scrolling
  // back down to the bottom re-enables it.
  const FOLLOW_THRESHOLD_PX = 40;
  function handleScroll() {
    if (!containerEl) return;
    const distanceFromBottom =
      containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight;
    if (distanceFromBottom > FOLLOW_THRESHOLD_PX) {
      follow = false;
    } else {
      follow = true;
      newLinesCount = 0;
    }
  }

  function jumpToBottom() {
    follow = true;
    newLinesCount = 0;
    queueScrollToBottom();
  }

  // ── Toolbar: search + level filter + wrap ───────────────────────────────
  let search = $state("");
  let levelFilter = $state<"all" | "error" | "warn" | "info">("all");
  let wrap = $state(false);
  let searchInputEl = $state<HTMLInputElement | null>(null);

  const errorCount = $derived(lines.filter((l) => l.level === "error").length);
  const warnCount = $derived(lines.filter((l) => l.level === "warn").length);
  const infoCount = $derived(lines.filter((l) => l.level === "info").length);

  const visibleLines = $derived.by(() => {
    const query = search.trim().toLowerCase();
    return lines.filter((line) => {
      if (levelFilter !== "all" && line.level !== levelFilter) return false;
      if (query && !line.text.toLowerCase().includes(query)) return false;
      return true;
    });
  });

  // Splits a line's text into plain/matched segments for <mark> highlighting.
  function highlightSegments(text: string, query: string): { text: string; match: boolean }[] {
    const q = query.trim();
    if (!q) return [{ text, match: false }];
    const needle = q.toLowerCase();
    const haystack = text.toLowerCase();
    const segments: { text: string; match: boolean }[] = [];
    let i = 0;
    while (i < text.length) {
      const idx = haystack.indexOf(needle, i);
      if (idx === -1) {
        segments.push({ text: text.slice(i), match: false });
        break;
      }
      if (idx > i) segments.push({ text: text.slice(i, idx), match: false });
      segments.push({ text: text.slice(idx, idx + needle.length), match: true });
      i = idx + needle.length;
    }
    return segments;
  }

  function handleRootKeydown(event: KeyboardEvent) {
    if (event.key !== "/") return;
    const target = event.target as HTMLElement | null;
    const isTypingTarget =
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (isTypingTarget) return; // let "/" be typed normally
    event.preventDefault();
    searchInputEl?.focus();
  }

  function downloadLogs() {
    const content = visibleLines.map((l) => l.raw).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${stationId}-logs.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  onMount(() => {
    connect();
  });

  onDestroy(() => {
    clearReconnectTimer();
    if (scrollTimer !== null) {
      clearTimeout(scrollTimer);
      scrollTimer = null;
    }
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    es?.close();
    es = null;
    status = "closed";
  });

  const statusLabel: Record<Status, string> = {
    connecting: "Connecting…",
    connected: "Connected",
    reconnecting: "Reconnecting…",
    closed: "Disconnected",
  };
  // Session lifecycle → shared status vocabulary, so log-stream state speaks
  // the same color language as everything else in the console.
  const statusToken: Record<Status, string> = {
    connecting: "starting",
    connected: "connected",
    reconnecting: "starting",
    closed: "error",
  };
  function levelClass(level: Level): string {
    if (level === "error") return "text-status-error";
    if (level === "warn") return "text-status-degraded";
    if (level === "info") return "text-foreground";
    return "text-muted-foreground";
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -- keydown only listens for
     "/" bubbling up from focused descendants to jump focus to the search box -->
<div
  class="flex flex-col h-full min-h-[200px] rounded-lg border bg-background font-mono text-xs"
  onkeydown={handleRootKeydown}
>
  <!-- Toolbar -->
  <div class="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 shrink-0">
    <TerminalIcon class="size-3.5 text-muted-foreground" aria-hidden="true" />
    <!-- Live region: screen-reader users hear connection transitions
         (connect/reconnect/give-up), not just sighted users. -->
    <span
      role="status"
      aria-live="polite"
      class={cn("shrink-0", statusTextClass(statusToken[status]))}>{statusLabel[status]}</span
    >
    {#if status === "closed"}
      <Button variant="outline" size="xs" onclick={retryNow}>Retry</Button>
    {/if}

    <div class="relative min-w-[9rem] flex-1">
      <SearchIcon
        class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        bind:this={searchInputEl}
        type="search"
        placeholder="Search logs…"
        bind:value={search}
        class="h-6 w-full rounded-md border bg-transparent py-1 pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
        aria-label="Search logs"
      />
    </div>

    <div class="flex items-center gap-1" role="group" aria-label="Filter by level">
      <button
        type="button"
        class={chipClass(levelFilter === "all")}
        aria-pressed={levelFilter === "all"}
        onclick={() => (levelFilter = "all")}
      >
        All
      </button>
      <button
        type="button"
        class={chipClass(levelFilter === "error", "error")}
        aria-pressed={levelFilter === "error"}
        onclick={() => (levelFilter = "error")}
      >
        Error {errorCount}
      </button>
      <button
        type="button"
        class={chipClass(levelFilter === "warn", "degraded")}
        aria-pressed={levelFilter === "warn"}
        onclick={() => (levelFilter = "warn")}
      >
        Warn {warnCount}
      </button>
      <button
        type="button"
        class={chipClass(levelFilter === "info")}
        aria-pressed={levelFilter === "info"}
        onclick={() => (levelFilter = "info")}
      >
        Info {infoCount}
      </button>
    </div>

    <button
      type="button"
      class={chipClass(follow)}
      aria-pressed={follow}
      onclick={() => (follow ? (follow = false) : jumpToBottom())}
    >
      Follow
    </button>

    <button
      type="button"
      class={chipClass(wrap)}
      aria-pressed={wrap}
      onclick={() => (wrap = !wrap)}
    >
      Wrap
    </button>

    <Button variant="outline" size="xs" onclick={downloadLogs} aria-label="Download visible logs">
      <DownloadIcon class="size-3.5" aria-hidden="true" />
    </Button>

    <span class="ml-auto shrink-0 text-muted-foreground">{lines.length} {lines.length === 1 ? "line" : "lines"}</span>
  </div>

  <!-- Log lines -->
  <div class="relative flex-1 min-h-0">
    <div
      bind:this={containerEl}
      data-testid="log-scroll-container"
      class="h-full overflow-y-auto py-1"
      onscroll={handleScroll}
    >
      {#if lines.length === 0 && status === "connected"}
        <Empty
          title="No log output yet"
          description="The agent is connected but hasn’t logged anything."
          icon={TerminalIcon}
          class="border-none"
        />
      {:else if lines.length === 0}
        <div class="px-3 py-1 italic text-muted-foreground">Waiting for log output…</div>
      {:else if visibleLines.length === 0}
        <div class="px-3 py-1 italic text-muted-foreground">No lines match the current filter</div>
      {:else}
        {#each visibleLines as line, i (i)}
          <div
            class={cn(
              "log-line px-3",
              wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
              levelClass(line.level),
            )}
          >
            {#each highlightSegments(line.text, search) as seg, si (si)}
              {#if seg.match}<mark>{seg.text}</mark>{:else}{seg.text}{/if}
            {/each}
          </div>
        {/each}
      {/if}
    </div>

    {#if !follow && newLinesCount > 0}
      <button
        type="button"
        class="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full border bg-background px-3 py-1 text-xs shadow-md hover:bg-muted"
        onclick={jumpToBottom}
      >
        {newLinesCount} new {newLinesCount === 1 ? "line" : "lines"}
        <ArrowDownIcon class="size-3" aria-hidden="true" />
      </button>
    {/if}
  </div>
</div>

<style>
  .log-line {
    content-visibility: auto;
    contain-intrinsic-size: auto 1.25rem;
  }
</style>
