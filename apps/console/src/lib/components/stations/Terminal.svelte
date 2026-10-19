<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { createTerminalClient } from "$lib/api/terminal";
  import { socketToken } from "$lib/api/client";
  import type { TerminalClient, TerminalCloseReason } from "$lib/api/terminal";
  import { mix, onAppearanceChange, terminalTheme, tokenHex } from "$lib/utils/vk-colors";
  import { Button } from "$lib/components/ui/button";
  import { cn } from "$lib/utils";
  import { Status as StatusIndicator } from "$lib/components/ui/status";
  import SearchIcon from "@lucide/svelte/icons/search";
  import ChevronUpIcon from "@lucide/svelte/icons/chevron-up";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import EraserIcon from "@lucide/svelte/icons/eraser";
  import Maximize2Icon from "@lucide/svelte/icons/maximize-2";
  import Minimize2Icon from "@lucide/svelte/icons/minimize-2";
  import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";

  interface Props {
    stationId: string;
  }

  let { stationId }: Props = $props();

  type Status = "connecting" | "connected" | "reconnecting" | "closed";

  // Reconnect budget: 3 attempts, backing off 1s / 2s / 4s. Reset to 0 on a
  // successful connection or when the caller clicks the manual Reconnect button.
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [1000, 2000, 4000];

  let containerEl = $state<HTMLDivElement | null>(null);
  let status = $state<Status>("connecting");
  let closeMessage = $state("Connection lost");
  let fullscreen = $state(false);
  let searchQuery = $state("");
  let searchInputEl = $state<HTMLInputElement | null>(null);

  // Plain (non-reactive) refs — async onMount setup and timers can't rely on
  // Svelte's automatic cleanup, so they're held here for onDestroy to reach.
  let client: TerminalClient | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0; // reconnect attempts used since the last successful connect

  // xterm.js + its addons are dynamic-imported (browser-only), so these stay
  // loosely typed rather than pulling in @xterm/xterm as a static import that
  // would break SSR/build.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let term: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fitAddon: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let searchAddon: any = null;

  // ── Palette from the vibe ──────────────────────────────────────────────
  // xterm needs hex: terminalTheme() reads the live vibekit tokens (16 ANSI colours,
  // each readable on the vibe's ground). It repaints whenever <html>'s vibe or theme
  // changes, including a change that lands inside a view transition.
  function computeXtermTheme() {
    return terminalTheme();
  }

  $effect(() => onAppearanceChange(() => {
    if (term) {
      term.options.theme = computeXtermTheme();
      term.options.fontFamily = monoStack();
      fitAddon?.fit();
    }
  }));

  // Each vibe has its own mono font: xterm can't read CSS variables, so resolve
  // the concrete stack (and refit, above, when the vibe changes).
  function monoStack(): string {
    const themeMono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
    return [themeMono || null, "ui-monospace, 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace"]
      .filter(Boolean)
      .join(", ");
  }

  // The search addon's decorations need hex: the vibe's signal for matches, its accent for the active one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildSearchOptions(): any {
    const match = tokenHex("signal-wash") || tokenHex("signal");
    const active = tokenHex("accent");
    if (!match || !active) return {};
    return {
      decorations: {
        matchBackground: match,
        matchBorder: tokenHex("signal") || match,
        matchOverviewRuler: tokenHex("signal") || match,
        activeMatchBackground: mix(match, active, 0.5),
        activeMatchBorder: active,
        activeMatchColorOverviewRuler: active,
      },
    };
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function startConnection() {
    status = attempt === 0 ? "connecting" : "reconnecting";

    // A fresh token per dial (reconnects included) under the org plane; null — the cookie — in legacy.
    const c = createTerminalClient(stationId, socketToken());
    client = c;

    c.onData((text: string) => {
      term?.write(text);
      if (status !== "connected") {
        status = "connected";
        attempt = 0;
      }
    });

    c.onClose((reason: TerminalCloseReason) => handleClose(c, reason));

    if (term) {
      c.resize(term.cols, term.rows);
    }
  }

  function handleClose(c: TerminalClient, reason: TerminalCloseReason) {
    // Ignore a close from a client that's no longer the active one (can
    // happen if a reconnect raced with an in-flight teardown).
    if (client !== c) return;
    client = null;

    if (reason === "exit") {
      clearReconnectTimer();
      status = "closed";
      closeMessage = "Session ended";
      return;
    }

    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (attempt >= MAX_ATTEMPTS) {
      status = "closed";
      closeMessage = "Connection lost";
      return;
    }
    status = "reconnecting";
    const delay = BACKOFF_MS[attempt];
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startConnection();
    }, delay);
  }

  /** Manual "Reconnect" button — resets the backoff budget before retrying. */
  function manualReconnect() {
    clearReconnectTimer();
    attempt = 0;
    startConnection();
  }

  // ── Ergonomics: search, clear, fullscreen, copy/paste ─────────────────────

  function findNext() {
    if (!searchAddon || !searchQuery) return;
    searchAddon.findNext(searchQuery, buildSearchOptions());
  }

  function findPrevious() {
    if (!searchAddon || !searchQuery) return;
    searchAddon.findPrevious(searchQuery, buildSearchOptions());
  }

  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (event.shiftKey) findPrevious();
    else findNext();
  }

  function clearTerminal() {
    term?.clear();
  }

  function refit() {
    requestAnimationFrame(() => fitAddon?.fit());
  }

  function toggleFullscreen() {
    fullscreen = !fullscreen;
    refit();
  }

  // Scoped (not window-level) so this doesn't steal ⌘F / Escape from the rest
  // of the app while the Terminal tab sits kept-alive off-screen — it only
  // fires while focus is already somewhere inside this component.
  function handleRootKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && fullscreen) {
      event.preventDefault();
      fullscreen = false;
      refit();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      searchInputEl?.focus();
    }
  }

  function handlePasteContextMenu(event: MouseEvent) {
    event.preventDefault();
    navigator.clipboard
      ?.readText()
      .then((text) => {
        if (text) client?.send(text);
      })
      .catch(() => {
        // Clipboard read denied/unavailable — nothing to paste.
      });
  }

  // Session lifecycle → shared status vocabulary + a spoken label, so the
  // connection dot is never a color-only signal.
  const sessionStatus = $derived(
    status === "connected" ? "connected" : status === "closed" ? "error" : "starting",
  );
  const sessionLabel = $derived(
    status === "connecting"
      ? "Connecting…"
      : status === "connected"
        ? "Connected"
        : status === "reconnecting"
          ? "Reconnecting…"
          : closeMessage,
  );

  // ── Mount / teardown ───────────────────────────────────────────────────────

  onMount(() => {
    // Fire-and-forget: run the async setup inside onMount without returning a
    // Promise (Svelte's onMount signature doesn't support async cleanup returns).
    void (async () => {
      const [{ Terminal }, { FitAddon }, { SearchAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-search"),
        import("@xterm/addon-web-links"),
      ]);

      // Import xterm CSS dynamically alongside the module
      await import("@xterm/xterm/css/xterm.css");

      if (!containerEl) return;

      // xterm measures cell width via canvas font strings, which CANNOT
      // resolve CSS variables — passing var(--font-mono) makes it measure a
      // fallback font while drawing another, rendering the huge-letter-spacing
      // "s t r e t c h e d" prompt. Resolve the theme's mono stack to concrete
      // family names first, and wait for the webfont so metrics are real.
      const themeMono = getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim();
      const fontFamily = monoStack();
      try {
        await Promise.race([
          document.fonts.load(`13px ${themeMono.split(",")[0] ?? "monospace"}`),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
      } catch {
        // Font loading is best-effort; fallback metrics are still consistent.
      }
      if (!containerEl) return;

      term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily,
        theme: computeXtermTheme(),
        // Mirrors terminal output into an ARIA live buffer — without this the
        // entire terminal is invisible to screen readers.
        screenReaderMode: true,
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      searchAddon = new SearchAddon();
      term.loadAddon(searchAddon);

      term.loadAddon(new WebLinksAddon());

      // WebGL rendering is a non-blocking nicety — fall back silently to the
      // default canvas renderer if the addon or the browser doesn't cooperate.
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const webgl: any = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // WebGL unsupported/unavailable — canvas renderer is fine.
      }

      term.open(containerEl);
      fitAddon.fit();

      // Terminal → hub: forward keystrokes / paste
      term.onData((data: string) => {
        client?.send(data);
      });

      // Copy-on-select: mirror a native terminal's clipboard behaviour.
      term.onSelectionChange(() => {
        const selection = term.getSelection();
        if (selection && document.hasFocus()) {
          navigator.clipboard?.writeText(selection).catch(() => {
            // Clipboard write denied/unavailable — selection still stands.
          });
        }
      });

      // Re-fit and resize whenever the container changes size, debounced so a
      // drag-resize doesn't spam the hub with resize messages.
      resizeObserver = new ResizeObserver(() => {
        if (resizeDebounceTimer !== null) clearTimeout(resizeDebounceTimer);
        resizeDebounceTimer = setTimeout(() => {
          resizeDebounceTimer = null;
          fitAddon?.fit();
          if (term && client) client.resize(term.cols, term.rows);
        }, 100);
      });
      resizeObserver.observe(containerEl);

      startConnection();
    })();
  });

  onDestroy(() => {
    clearReconnectTimer();
    if (resizeDebounceTimer !== null) {
      clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = null;
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    // close() on the client suppresses its onClose callback (per terminal.ts's
    // contract), so this teardown never races with the reconnect logic above.
    client?.close();
    client = null;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    term?.dispose();
    term = null;
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -- keydown only reacts to
     Escape/⌘F bubbling up from focus already inside this component -->
<div
  class={cn(
    "ap-term flex flex-col rounded-lg border bg-background",
    fullscreen ? "fixed inset-0 z-50 p-2" : "h-full min-h-[200px]",
  )}
  onkeydown={handleRootKeydown}
>
  <!-- Toolbar -->
  <div class="ap-term-tool flex flex-wrap items-center gap-2 border-b px-3 py-1.5 shrink-0">
    <span role="status" aria-live="polite" class="inline-flex shrink-0">
      <StatusIndicator
        form="dot"
        status={sessionStatus}
        label={sessionLabel}
        animate={status === "connecting" || status === "reconnecting"}
      />
    </span>
    <span class="shrink-0 truncate font-mono text-xs text-muted-foreground">{stationId}</span>

    {#if status === "closed"}
      <span class="shrink-0 text-xs text-status-error">{closeMessage}</span>
      <Button variant="outline" size="xs" onclick={manualReconnect}>
        <RotateCwIcon class="size-3" aria-hidden="true" />
        Reconnect
      </Button>
    {/if}

    <div class="relative min-w-[8rem] flex-1">
      <SearchIcon
        class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        bind:this={searchInputEl}
        type="search"
        placeholder="Search terminal…"
        bind:value={searchQuery}
        onkeydown={handleSearchKeydown}
        class="ap-term-search h-6 w-full rounded-md border bg-transparent py-1 pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
        aria-label="Search terminal"
      />
    </div>

    <Button variant="outline" size="icon-xs" onclick={findPrevious} aria-label="Previous match">
      <ChevronUpIcon class="size-3" aria-hidden="true" />
    </Button>
    <Button variant="outline" size="icon-xs" onclick={findNext} aria-label="Next match">
      <ChevronDownIcon class="size-3" aria-hidden="true" />
    </Button>

    <Button variant="outline" size="xs" onclick={clearTerminal}>
      <EraserIcon class="size-3" aria-hidden="true" />
      Clear
    </Button>

    <Button
      variant="outline"
      size="icon-xs"
      onclick={toggleFullscreen}
      aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
    >
      {#if fullscreen}
        <Minimize2Icon class="size-3" aria-hidden="true" />
      {:else}
        <Maximize2Icon class="size-3" aria-hidden="true" />
      {/if}
    </Button>
  </div>

  <!-- xterm.js mount point -->
  <div
    bind:this={containerEl}
    class="ap-term-screen flex-1 overflow-hidden p-1"
    style="min-height:0"
    oncontextmenu={handlePasteContextMenu}
  ></div>
</div>
