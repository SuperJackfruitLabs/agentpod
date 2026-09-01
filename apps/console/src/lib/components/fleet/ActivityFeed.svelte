<script module lang="ts">
  import type { ActivityRow } from "$lib/api/client";
  import { STATE, type StateId, type StateInfo } from "$lib/fleet/state";

  // Tailwind's JIT scanner needs full class names present verbatim in source,
  // so this is a literal lookup rather than `text-status-${token}`. Same
  // reason StateDot carries STATE_BG_CLASS; status-badge.ts's TEXT map can't
  // be reused because its vocabulary has no `unknown`.
  export const STATE_TEXT_CLASS: Record<StateId, string> = {
    running: "text-status-running",
    starting: "text-status-starting",
    unknown: "text-status-unknown",
    error: "text-status-error",
    sleeping: "text-status-sleeping",
    stopped: "text-status-stopped",
  };

  /** One rendered line: a run of consecutive rows that said the same thing. */
  export interface ActivityGroup {
    /** The id of the newest row in the run — stable enough to key on. */
    id: string;
    verb: string;
    result: string;
    /** How many consecutive rows merged. 1 means nothing merged. */
    count: number;
    /** The newest row of the run; the one whose time and subject we show. */
    head: ActivityRow;
  }

  /**
   * An audit result → the fleet's state vocabulary.
   *
   * "pending" is `unknown` and not `starting`: the hub writes `pending` at the
   * moment an operation begins and only finalises it when the node answers, so
   * a row stuck on `pending` means nobody knows how it went — which is exactly
   * what unknown means everywhere else in this console.
   */
  export function resultState(result: string | undefined): StateInfo {
    switch (result) {
      case "ok":
        return STATE.running;
      case "error":
        return STATE.error;
      // "pending", undefined, and anything a future hub invents
      default:
        return STATE.unknown;
    }
  }

  /**
   * Collapses CONSECUTIVE rows sharing a verb AND a result.
   *
   * Consecutive is the whole rule: `posture.scan` ×18 in a row is one fact,
   * but `posture.scan / fs.write / posture.scan` is three, because something
   * happened in between. Grouping globally instead would silently reorder the
   * log and destroy the only thing an audit trail is for.
   */
  export function collapse(rows: ActivityRow[]): ActivityGroup[] {
    const groups: ActivityGroup[] = [];
    for (const row of rows) {
      const result = row.result ?? "unknown";
      const last = groups[groups.length - 1];
      if (last && last.verb === row.verb && last.result === result) {
        last.count += 1;
        continue;
      }
      groups.push({ id: row.id, verb: row.verb, result, count: 1, head: row });
    }
    return groups;
  }
</script>

<script lang="ts">
  /**
   * ActivityFeed — the fleet's audit log, with the machine's repetition
   * squeezed out of it.
   *
   * Shared by the muster and the /activity page so both read the same way.
   * It renders what it is given and fetches nothing: the muster polls the
   * fleet through the shell's single poll and loads activity once, and
   * /activity owns its own reload button.
   */
  import { relativeTime } from "$lib/utils/relative-time";
  import StateDot from "$lib/components/shell/StateDot.svelte";
  import { cn } from "$lib/utils";

  interface Props {
    rows: ActivityRow[];
    /** Caps the COLLAPSED rows, so a burst of 18 can't crowd out everything else. */
    limit?: number;
  }

  let { rows, limit }: Props = $props();

  const groups = $derived.by(() => {
    const all = collapse(rows);
    return limit === undefined ? all : all.slice(0, limit);
  });

  /**
   * The subject the row is about. A station key is what a person recognises;
   * the node id is the fallback when the hub recorded a node-level verb.
   * Node ids are long and opaque, so they truncate to their first 9 chars —
   * enough to tell two nodes apart, short enough not to own the row.
   */
  function subject(row: ActivityRow): string {
    if (row.stationKey) return row.stationKey;
    if (row.nodeId) return row.nodeId.slice(0, 9);
    return "—";
  }
</script>

<!--
  overflow-x-auto: a long station key plus a long verb can exceed a narrow
  stage, and wide content scrolls in its own box rather than dragging the page
  sideways.
-->
<div data-testid="activity-feed" class="overflow-x-auto">
  {#if groups.length === 0}
    <p data-testid="activity-empty" class="py-6 text-sm text-muted-foreground">
      No activity yet. What the fleet does will show up here.
    </p>
  {:else}
    <ul>
      {#each groups as group (group.id)}
        {@const state = resultState(group.result)}
        <!--
          `relative` is load-bearing, not decoration: StateDot's sr-only label
          is position:absolute, and with no positioned ancestor its containing
          block is the initial one — overflow:hidden would not clip it and it
          would add to the document's scroll width.
        -->
        <li
          data-testid="activity-row"
          class="relative flex items-center gap-3 border-b border-border/50 py-1.5 text-xs last:border-b-0"
        >
          <span class="w-16 shrink-0 font-mono text-muted-foreground">
            {relativeTime(group.head.createdAt)}
          </span>

          <span data-testid="activity-tick" class="shrink-0">
            <StateDot {state} size="sm" />
          </span>

          <span class="shrink-0 font-mono text-foreground">{group.verb}</span>

          {#if group.count > 1}
            <span
              data-testid="activity-repeat"
              class="shrink-0 rounded-sm bg-muted px-1 font-mono text-[10px] text-muted-foreground"
              title="{group.count} in a row"
            >
              ×{group.count}
            </span>
          {/if}

          <span class="shrink-0 truncate font-mono text-muted-foreground">{subject(group.head)}</span>

          <!-- The detail: which node it happened on, when the subject was a
               station and so did not already say. GET /api/activity returns
               no free-text detail of its own — see the task report. -->
          {#if group.head.stationKey && group.head.nodeId}
            <span class="shrink-0 font-mono text-muted-foreground/60">
              on {group.head.nodeId.slice(0, 9)}
            </span>
          {/if}

          <span class={cn("ml-auto shrink-0 pl-3", STATE_TEXT_CLASS[state.token])}>
            {group.result}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
