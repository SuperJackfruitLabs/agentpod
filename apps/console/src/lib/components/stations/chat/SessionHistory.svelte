<script lang="ts">
  /**
   * SessionHistory — every ACP session on a station, paginated, read-only.
   *
   * A DIALOG, deliberately: the chat panel behind it stays MOUNTED, so the live
   * socket, the transcript and the per-session draft all survive browsing the
   * history (the repo's usual list→detail idiom is routing, which would tear the
   * panel down and re-attach on the way back — for a picker that is pure loss).
   * `ui/sheet` is also in the kit but is used nowhere in this console; a second
   * overlay idiom for one list isn't worth introducing, and every other overlay
   * here (ConfirmDialog, NewRuntimeDialog, …) is a Dialog.
   *
   * Read-only by construction: a row ATTACHES (through the panel's one
   * `selectSession` path — this component only reports the id it was given), and
   * there is no end/delete action anywhere on the surface. Sessions are
   * hub-owned; browsing history must never stop an agent process.
   *
   * It adds NO live region: the chat header owns the ONE status region in the
   * panel, and a second one would announce every session flip twice. The load
   * error is therefore plain text next to the control that triggered it, not an
   * alert.
   *
   * Paging is cursor-based, not offset-based: an offset would skip or repeat rows
   * as sessions keep streaming and the top of the list moves. The cursor is the
   * last row's `lastEventAt` AND its id (`before` + `beforeId`) — the timestamp
   * alone is only millisecond-resolution, so a boundary inside a group of tied
   * timestamps would drop the tied rows that missed the earlier page out of every
   * later page too, losing them from history entirely.
   *
   * The hub answers with a BARE array: no `hasMore`, no `nextCursor`, so a page
   * shorter than PAGE_SIZE is what "last page" means. Pages are still merged BY
   * ID — a session whose activity bumps between requests can arrive twice, and a
   * duplicate would break the keyed list.
   */
  import { onMount } from "svelte";
  import { listAcpSessions, type AcpSessionRow } from "$lib/api/acp";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Empty } from "$lib/components/ui/empty";
  import { Status } from "$lib/components/ui/status";
  import { relativeTime } from "$lib/utils/relative-time";
  import { ACP_STATUS_TOKEN, sessionName } from "./session-status";

  interface Props {
    stationId: string;
    /** The session the panel has attached — marked, never treated specially. */
    currentSessionId: string | null;
    /** Attach this session. The panel routes it through its own switcher path. */
    onSelect: (sessionId: string) => void;
    onClose: () => void;
  }

  let { stationId, currentSessionId, onSelect, onClose }: Props = $props();

  /** Page size. The hub clamps at 100; 20 is one screenful of scrolling. */
  const PAGE_SIZE = 20;

  let rows = $state<AcpSessionRow[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  /** True once a page came back short — the hub has nothing older to give. */
  let exhausted = $state(false);

  /** The compound cursor for "everything older than this row". */
  type Cursor = { before: string; beforeId: string };

  async function loadPage(cursor?: Cursor): Promise<void> {
    loading = true;
    error = null;
    try {
      const page = await listAcpSessions(
        stationId,
        cursor === undefined ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, ...cursor },
      );
      // Append, never replace: the user keeps their place in the list. Rows
      // already on screen win — a bumped session must not jump to the bottom.
      rows =
        cursor === undefined
          ? page
          : [...rows, ...page.filter((s) => !rows.some((seen) => seen.id === s.id))];
      // No `hasMore` from the hub: a short page is the end of the list. Measured
      // on the PAGE, not on the merged rows — de-duplication can shorten it.
      if (page.length < PAGE_SIZE) exhausted = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadPage();
  });

  /** The oldest row on screen is the cursor for the next (older) page. */
  const olderCursor = $derived.by((): Cursor | undefined => {
    const last = rows.at(-1);
    return last === undefined ? undefined : { before: last.lastEventAt, beforeId: last.id };
  });

  /**
   * Untitled rows can't borrow the header's "Session N": that number comes from
   * the whole list's creation order, which a paginated view doesn't have.
   */
  const nameOf = (s: AcpSessionRow) => sessionName(s, "Untitled session");

  /**
   * "12 events" — `lastSeq` is the session's highest event seq, so it doubles as
   * its size. Omitted entirely (rather than shown as 0) when an older hub didn't
   * send it: an invented count is worse than no count.
   */
  function eventCount(s: AcpSessionRow): string | null {
    if (s.lastSeq === undefined) return null;
    if (s.lastSeq === 0) return "no events";
    return s.lastSeq === 1 ? "1 event" : `${s.lastSeq} events`;
  }

  function choose(sessionId: string): void {
    // Attach first, then get out of the way — closing first would leave the
    // panel's focus moving while an attach is still in flight.
    onSelect(sessionId);
    onClose();
  }
</script>

<Dialog.Root open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>All sessions</Dialog.Title>
      <Dialog.Description>
        Every chat session on this station, newest activity first. Opening one is read-only
        until you send a message.
      </Dialog.Description>
    </Dialog.Header>

    {#if error}
      <!-- Not a live region (the header owns the panel's only one) — it sits
           beside the control that failed, where focus already is. -->
      <p class="t-label text-status-error">{error}</p>
    {/if}

    {#if rows.length === 0}
      {#if loading}
        <p class="t-label text-muted-foreground">Loading sessions…</p>
      {:else if error === null}
        <Empty
          title="No sessions yet"
          description="Send a message in the composer and the session will show up here."
        />
      {/if}
    {:else}
      <ul class="-mx-1 max-h-[55vh] min-w-0 overflow-y-auto">
        {#each rows as s (s.id)}
          <li class="min-w-0">
            <button
              type="button"
              class="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-current={s.id === currentSessionId ? "true" : undefined}
              onclick={() => choose(s.id)}
            >
              <!-- The badge carries the status word itself, so the token is only
                   there for colour — hence the label override. -->
              <span class="shrink-0">
                <Status form="badge" status={ACP_STATUS_TOKEN[s.status]} label={s.status} />
              </span>
              <span class="min-w-0 flex-1">
                <!-- min-w-0 + truncate: titles are up to 80 chars of prose. -->
                <span class="block truncate text-sm text-foreground">{nameOf(s)}</span>
                <span class="t-label block truncate">
                  {relativeTime(s.lastEventAt)}{eventCount(s) ? ` · ${eventCount(s)}` : ""}
                </span>
              </span>
              {#if s.id === currentSessionId}
                <span class="t-label shrink-0">on screen</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>

      {#if !exhausted}
        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={loading} onclick={() => void loadPage(olderCursor)}>
            Load older
          </Button>
          {#if loading}
            <span class="t-label text-muted-foreground">Loading…</span>
          {/if}
        </div>
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>
