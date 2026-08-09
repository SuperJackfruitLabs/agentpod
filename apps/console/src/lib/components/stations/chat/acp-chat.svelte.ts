/**
 * acp-chat.svelte.ts
 *
 * AcpChat — the stateful session controller behind a station's chat panel.
 * One instance per panel (no module-level state). It orchestrates:
 *
 *   - the ACP api client ($lib/api/acp): REST session lifecycle + the WS
 *     bridge (createAcpSocket), and
 *   - the pure transcript projection (./transcript): every server event is
 *     folded immutably, so views key off item references.
 *
 * Lifecycle contracts (hub-owned sessions):
 *   - `destroy()` closes the socket ONLY — it never DELETEs. A WS close is
 *     never session end; the session keeps running on the hub and a later
 *     socket re-subscribes and replays.
 *   - `end()` is the only DELETE path. Even then the UI settles on the
 *     hub's own `state: ended` event / `bye` — nothing is forced locally.
 *   - Reconnects (budget 3, backoff 1s/2s/4s — mirrors Terminal.svelte)
 *     re-subscribe with `sinceSeq = transcript.lastSeq` so replay fills the
 *     gap ("working while away").
 *   - `bye` arrives as a server MESSAGE; the socket close that follows it is
 *     expected and must not trigger a reconnect.
 *
 * Error surfacing: a synthetic seq-0 error appears in ONE place, never two —
 * as the fate of an OUTSTANDING prompt (dropped, text handed back via
 * `onPromptFailed`, message on `error`), else inline as a transcript notice
 * while a turn is live, else on `error` for the panel's strip. "Outstanding" is
 * tracked, not guessed from position: the hub's error frame is the catch-all for
 * every client frame (cancel, permission-answer, set-mode), so a trailing
 * pending prompt alone proves nothing.
 *
 * An optimistic prompt is never left pending forever — that would freeze `busy`
 * and the composer with it. It is resolved by exactly one of: the echoed
 * user-prompt event (reconciled), an error attributed to it, `replay-done` with
 * the tail still pending (the hub never saw it), reconnect-budget exhaustion
 * (replay will never happen), or the session ending.
 *
 * Permission dismissal: ACP has no per-request dismiss — agents supply reject
 * options in the request itself (answer with one of those), and `cancel()`
 * rejects ALL parked permissions (hub cancelTurn). Wire the UI accordingly.
 */

import type { AcpEvent, AcpSessionMode, AcpSessionStatus } from "@agentpod/contract";
import {
  createAcpSession,
  createAcpSocket,
  endAcpSession,
  listAcpSessions,
  type AcpServerMsg,
  type AcpSessionRow,
  type AcpSocket,
} from "$lib/api/acp";
import {
  addPendingPrompt,
  dropPendingPrompt,
  emptyTranscript,
  foldEvent,
  type Transcript,
} from "./transcript";

export type ChatConnection = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];

const OFFLINE_COPY = "Couldn't reach the hub — check your connection.";
const LOST_PROMPT_COPY = "Couldn't send that message — it's back in the box, try again.";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export class AcpChat {
  // ── Reactive state ($state-backed, exposed via getters) ────────────────────
  #session = $state<AcpSessionRow | null>(null);
  #transcript = $state<Transcript>(emptyTranscript());
  #connection = $state<ChatConnection>("idle");
  #error = $state<string | null>(null);

  /** Mode selector state; defaults "ask", synced from the session row. */
  mode = $state<AcpSessionMode>("ask");

  // ── Plain (non-reactive) refs — timers and the live socket ────────────────
  private readonly stationId: string;
  private socket: AcpSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Reconnect attempts used since the last successful connect. */
  private attempt = 0;
  /** Set on `bye`: the session is over — the following close is expected. */
  private sessionOver = false;
  /**
   * True while a prompt frame is outstanding and NOTHING else has been sent
   * since. Only then may a hub error be read as that prompt's fate: the hub
   * uses the same error frame for cancel/permission-answer/set-mode failures,
   * and misattributing one would restore a draft the user might send twice
   * while the real prompt is still on its way.
   */
  private awaitingEcho = false;
  /**
   * The socket a still-pending prompt frame was written to. A `replay-done` from
   * a DIFFERENT socket proves the hub never saw it (the replay would have
   * carried the echo); a replay-done from the same socket proves nothing — on a
   * fresh session the hub answers subscribe before it has finished handling the
   * prompt that was flushed right behind it.
   */
  private promptSocket: AcpSocket | null = null;
  private destroyed = false;

  /**
   * True while a createAcpSession POST is in flight (double-submit guard).
   * $state-backed because `busy` is read by the view: the composer must be
   * disabled for the whole create window, or PromptInput would clear a draft
   * that `prompt()` then silently refuses.
   */
  #creating = $state(false);

  /**
   * Called with the text of a prompt whose echo will never arrive (the hub
   * rejected the turn, or the socket died before it landed). The panel hands it
   * back to the composer so the user's words aren't lost with the turn.
   */
  private readonly onPromptFailed?: (text: string) => void;

  constructor(stationId: string, options: { onPromptFailed?: (text: string) => void } = {}) {
    this.stationId = stationId;
    this.onPromptFailed = options.onPromptFailed;
  }

  get session(): AcpSessionRow | null {
    return this.#session;
  }

  get transcript(): Transcript {
    return this.#transcript;
  }

  get connection(): ChatConnection {
    return this.#connection;
  }

  /** Last surfaced failure, "Couldn't …" copy. Cleared on prompt/reconnect. */
  get error(): string | null {
    return this.#error;
  }

  /**
   * The session status every view must render. Stream truth once it exists, but
   * `"starting"` doubles as the transcript's pre-event placeholder, so until a
   * state event lands the session row's own status wins — otherwise reattaching
   * to a *working* session reads as "starting" and the composer would happily
   * offer to send into a turn the hub will reject.
   *
   * The header, the composer and `working`/`busy` all read THIS. Two views on
   * two different status machines is how a user gets an enabled Send button
   * during someone else's turn.
   */
  get status(): AcpSessionStatus {
    return this.#transcript.status === "starting" && this.#session
      ? this.#session.status
      : this.#transcript.status;
  }

  get working(): boolean {
    return this.status === "working";
  }

  /** True while a socket is (re)connecting and its replay hasn't finished. */
  get replaying(): boolean {
    return (
      this.#session !== null && (this.#connection === "connecting" || this.#connection === "reconnecting")
    );
  }

  /**
   * True exactly when `prompt()` would refuse: a create is in flight, an
   * optimistic prompt is still awaiting its echo, the agent is working, or a
   * replay is still in flight (the transcript — and therefore the status — is
   * not yet trustworthy). The composer MUST be disabled (or shown as working)
   * whenever this is true — PromptInput only keeps a draft it wasn't allowed
   * to send.
   */
  get busy(): boolean {
    return this.#creating || this.working || this.hasPendingPrompt() || this.replaying;
  }

  get pendingPermissions(): number {
    let n = 0;
    for (const it of this.#transcript.items) {
      if (it.kind === "permission" && !it.answer) n += 1;
    }
    return n;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** List sessions; if the newest is non-ended, attach. Else stay idle (empty state). */
  async init(): Promise<void> {
    let rows: AcpSessionRow[];
    try {
      rows = await listAcpSessions(this.stationId);
    } catch (err) {
      this.#error = errMessage(err);
      return;
    }
    if (this.destroyed) return;

    // The hub doesn't guarantee order — pick the newest by createdAt (ISO
    // strings compare lexicographically).
    let newest: AcpSessionRow | null = null;
    for (const row of rows) {
      if (newest === null || row.createdAt > newest.createdAt) newest = row;
    }
    if (!newest || newest.status === "ended") return;

    this.#session = newest;
    this.mode = newest.mode;
    this.startConnection();
  }

  /**
   * Send a prompt, creating a session first if none is live.
   *
   * Refuses (silent no-op) whenever `busy` is true: a create in flight, an
   * optimistic prompt still awaiting its echo, the agent working (one turn at a
   * time), or a replay still in flight. The composer reads the same `busy`, so a
   * refused send always keeps its draft.
   */
  async prompt(text: string): Promise<void> {
    if (!text || this.destroyed) return;
    if (this.busy) return;
    this.#error = null;

    if (!this.#session || this.sessionOver || this.#transcript.status === "ended") {
      let row: AcpSessionRow;
      this.#creating = true;
      try {
        row = await createAcpSession(this.stationId, this.mode);
      } catch (err) {
        // The ApiError message already carries the right "Couldn't …" grammar.
        this.#error = errMessage(err);
        return;
      } finally {
        this.#creating = false;
      }
      if (this.destroyed) return;
      this.teardownSocket();
      this.sessionOver = false;
      this.attempt = 0;
      this.#session = row;
      this.mode = row.mode;
      this.#transcript = emptyTranscript();
      this.startConnection();
    } else if (!this.socket) {
      // e.g. after budget exhaustion: reopen before prompting. The socket
      // buffers pre-open sends, so subscribe still precedes the prompt.
      this.clearReconnectTimer();
      this.attempt = 0;
      this.startConnection();
    }

    this.#transcript = addPendingPrompt(this.#transcript, text);
    this.socket?.send({ t: "prompt", text });
    this.awaitingEcho = true;
    this.promptSocket = this.socket;
  }

  cancel(): void {
    this.awaitingEcho = false; // a later error could just as well be this frame's
    this.socket?.send({ t: "cancel" });
  }

  /**
   * Answer a permission request with one of its offered options. To reject,
   * answer with the agent-supplied reject option; `cancel()` rejects all
   * parked permissions — ACP has no per-request dismiss.
   */
  answer(requestSeq: number, optionId: string): void {
    this.awaitingEcho = false; // e.g. "No pending permission request." is not the prompt's fault
    this.socket?.send({ t: "permission-answer", requestSeq, optionId });
  }

  setMode(mode: AcpSessionMode): void {
    this.mode = mode;
    if (this.#session && !this.sessionOver) {
      this.awaitingEcho = false;
      this.socket?.send({ t: "set-mode", mode });
    }
  }

  /** REST DELETE — the only path that ends a session. UI settles on bye/ended. */
  async end(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    try {
      await endAcpSession(session.id);
    } catch (err) {
      this.#error = errMessage(err);
    }
    // The ended state arrives via the event stream (state: ended → bye);
    // nothing is forced locally.
  }

  /** After ended: reset to the empty state (keep nothing but the mode selector). */
  newSession(): void {
    this.clearReconnectTimer();
    this.teardownSocket();
    this.#session = null;
    this.#transcript = emptyTranscript();
    this.#connection = "idle";
    this.#error = null;
    this.sessionOver = false;
    this.awaitingEcho = false;
    this.promptSocket = null;
    this.attempt = 0;
  }

  /** Manual reconnect — resets the backoff budget before retrying. */
  retry(): void {
    if (this.destroyed || this.sessionOver || !this.#session) return;
    this.clearReconnectTimer();
    this.teardownSocket();
    this.attempt = 0;
    this.#error = null;
    this.startConnection();
  }

  /** Close the socket. NEVER ends the session — it stays live on the hub. */
  destroy(): void {
    this.destroyed = true;
    this.clearReconnectTimer();
    this.teardownSocket();
  }

  /** True while the last item is an optimistic prompt awaiting its echo. */
  private hasPendingPrompt(): boolean {
    const last = this.#transcript.items.at(-1);
    return last?.kind === "user" && last.pending === true;
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  private startConnection(): void {
    const session = this.#session;
    if (!session) return;
    this.#connection = this.attempt === 0 ? "connecting" : "reconnecting";

    const s = createAcpSocket(session.id);
    this.socket = s;
    s.onMessage((msg) => this.handleMessage(s, msg));
    s.onClose(() => this.handleClose(s));
    // Replay fills the gap since the cursor — this is the "working while
    // away" path on reconnect; 0 on a fresh session.
    s.send({ t: "subscribe", sinceSeq: this.#transcript.lastSeq });
  }

  private handleMessage(s: AcpSocket, msg: AcpServerMsg): void {
    // Ignore messages from a socket that's no longer the active one (a
    // reconnect raced with an in-flight teardown).
    if (this.socket !== s) return;

    switch (msg.t) {
      case "session":
        this.#session = msg.session;
        this.mode = msg.session.mode;
        break;
      case "event":
        this.applyEvent(msg.event);
        break;
      case "replay-done":
        this.#connection = "connected";
        this.attempt = 0;
        this.#error = null;
        // Replay is the authoritative answer to "did the hub see my prompt?" —
        // if it did, the echo arrived during this replay and reconciled the
        // pending item. Still pending after a replay on a DIFFERENT socket means
        // it never landed (a blip between send and delivery, or a socket that
        // died with the frame still queued), so release it rather than leave
        // `busy` — and the composer — stuck forever.
        if (this.hasPendingPrompt() && this.promptSocket !== s) {
          this.releasePendingPrompt();
          this.#error = LOST_PROMPT_COPY;
        }
        break;
      case "bye":
        this.handleBye(msg.reason);
        break;
    }
  }

  private applyEvent(ev: AcpEvent): void {
    // Synthetic seq-0 errors are hub-side failures outside the persisted stream:
    // they never advance the cursor, and they surface in exactly ONE place so the
    // same sentence never appears as both a transcript notice and a strip.
    if (ev.type === "error" && ev.seq === 0) {
      const message = isRecord(ev.payload) && typeof ev.payload.message === "string"
        ? ev.payload.message
        : "Something went wrong.";

      // An OUTSTANDING prompt (frame sent, nothing sent since, echo not yet
      // arrived) makes this error that prompt's fate — the hub refused the turn
      // ("Session is busy…", "…still starting."), so its echo will never come.
      // Drop it: the ghost bubble would otherwise sit there forever with `busy`
      // stuck true (read-only composer, no recovery short of a page reload), and
      // dropping it is also what makes folding safe again. Without the
      // attribution the pending item stays and waits for replay-done, budget
      // exhaustion or the session ending to resolve it.
      if (this.awaitingEcho && this.hasPendingPrompt()) {
        this.releasePendingPrompt();
        this.#error = message;
        return;
      }

      if (this.status === "working" || this.status === "waiting") {
        // Mid-turn: the error belongs inline, in the turn it happened to.
        this.#transcript = foldEvent(this.#transcript, ev);
        return;
      }
      // No live turn: the strip owns it — it's the actionable surface, next to
      // the composer the user is about to retype into.
      this.#error = message;
      return;
    }

    // An ending session appends a notice, which must never land between a
    // pending prompt and an echo that is now never coming — and a phantom
    // message in an ended transcript is a lie. Release first.
    if (ev.type === "state" && isRecord(ev.payload) && ev.payload.status === "ended") {
      this.releasePendingPrompt();
    }

    this.#transcript = foldEvent(this.#transcript, ev);
    if (ev.type === "user-prompt") {
      this.awaitingEcho = false; // reconciled
      this.promptSocket = null;
    }
  }

  /**
   * Drop a trailing optimistic prompt whose echo will never arrive and hand its
   * text back to the composer. Clears `busy`, so the composer is usable again.
   */
  private releasePendingPrompt(): void {
    this.awaitingEcho = false;
    this.promptSocket = null;
    const { transcript, text } = dropPendingPrompt(this.#transcript);
    if (text === null) return;
    this.#transcript = transcript;
    this.onPromptFailed?.(text);
  }

  private handleBye(reason: string): void {
    this.sessionOver = true;
    // Same rule as a real ended event: no phantom message survives the session.
    this.releasePendingPrompt();
    if (this.#transcript.status !== "ended") {
      // The hub's ended event didn't make it here — fold a final ended notice
      // locally (synthetic seq-0 state event: never advances the cursor).
      this.#transcript = foldEvent(this.#transcript, {
        sessionId: this.#session?.id ?? "",
        seq: 0,
        type: "state",
        payload: { status: "ended", reason },
        createdAt: new Date().toISOString(),
      });
    }
    this.clearReconnectTimer();
    this.teardownSocket(); // the server closes right after bye anyway
    this.#connection = "idle";
  }

  private handleClose(s: AcpSocket): void {
    // Stale-client guard (mirrors Terminal.svelte): a close from a replaced
    // socket must not touch the live connection.
    if (this.socket !== s) return;
    this.socket = null;
    if (this.destroyed) return;

    if (this.sessionOver || this.#transcript.status === "ended") {
      // The close after a bye / ended session is expected — no reconnect.
      this.#connection = "idle";
      return;
    }
    // Note: a socket drop never folds anything into the transcript (a notice
    // could land between a pending prompt and its echo) — failures surface
    // via `error` on budget exhaustion only.
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.attempt >= MAX_ATTEMPTS) {
      this.#connection = "disconnected";
      // The budget is gone: a prompt still awaiting its echo was either never
      // sent or will never be echoed, so release it rather than wedge the
      // composer behind a ghost bubble.
      this.releasePendingPrompt();
      this.#error = OFFLINE_COPY;
      return;
    }
    this.#connection = "reconnecting";
    const delay = BACKOFF_MS[this.attempt];
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startConnection();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Close and detach the current socket (manual close — fires no onClose). */
  private teardownSocket(): void {
    const s = this.socket;
    this.socket = null;
    s?.close();
  }
}
