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
 * Permission dismissal: ACP has no per-request dismiss — agents supply reject
 * options in the request itself (answer with one of those), and `cancel()`
 * rejects ALL parked permissions (hub cancelTurn). Wire the UI accordingly.
 */

import type { AcpEvent, AcpSessionMode } from "@agentpod/contract";
import {
  createAcpSession,
  createAcpSocket,
  endAcpSession,
  listAcpSessions,
  type AcpServerMsg,
  type AcpSessionRow,
  type AcpSocket,
} from "$lib/api/acp";
import { addPendingPrompt, emptyTranscript, foldEvent, type Transcript } from "./transcript";

export type ChatConnection = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];

const OFFLINE_COPY = "Couldn't reach the hub — check your connection.";

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
  /** True while a createAcpSession POST is in flight (double-submit guard). */
  private creating = false;
  private destroyed = false;

  constructor(stationId: string) {
    this.stationId = stationId;
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

  get working(): boolean {
    return this.#transcript.status === "working";
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
   * Double-submission guard: refuses (silent no-op) while a create is in
   * flight, while a pending optimistic prompt is still awaiting its echo, or
   * while the agent is working — one turn at a time.
   */
  async prompt(text: string): Promise<void> {
    if (!text || this.destroyed) return;
    if (this.creating || this.working || this.hasPendingPrompt()) return;
    this.#error = null;

    if (!this.#session || this.sessionOver || this.#transcript.status === "ended") {
      let row: AcpSessionRow;
      this.creating = true;
      try {
        row = await createAcpSession(this.stationId, this.mode);
      } catch (err) {
        // The ApiError message already carries the right "Couldn't …" grammar.
        this.#error = errMessage(err);
        return;
      } finally {
        this.creating = false;
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
  }

  cancel(): void {
    this.socket?.send({ t: "cancel" });
  }

  /**
   * Answer a permission request with one of its offered options. To reject,
   * answer with the agent-supplied reject option; `cancel()` rejects all
   * parked permissions — ACP has no per-request dismiss.
   */
  answer(requestSeq: number, optionId: string): void {
    this.socket?.send({ t: "permission-answer", requestSeq, optionId });
  }

  setMode(mode: AcpSessionMode): void {
    this.mode = mode;
    if (this.#session && !this.sessionOver) {
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
        break;
      case "bye":
        this.handleBye(msg.reason);
        break;
    }
  }

  private applyEvent(ev: AcpEvent): void {
    // Synthetic seq-0 errors (hub-side failures outside the persisted stream)
    // never advance the cursor. Two extra caller rules apply here:
    if (ev.type === "error" && ev.seq === 0) {
      const message = isRecord(ev.payload) && typeof ev.payload.message === "string"
        ? ev.payload.message
        : "Something went wrong.";
      const last = this.#transcript.items.at(-1);
      if (last?.kind === "user" && last.pending) {
        // Never fold a notice between an optimistic pending prompt and its
        // echoed user-prompt event — the reconcile only checks the LAST item.
        this.#error = message;
        return;
      }
      this.#transcript = foldEvent(this.#transcript, ev);
      const status = this.#transcript.status;
      if (status !== "working" && status !== "waiting") {
        // No live turn: also surface via the strip so the input area shows it.
        this.#error = message;
      }
      return;
    }

    this.#transcript = foldEvent(this.#transcript, ev);
  }

  private handleBye(reason: string): void {
    this.sessionOver = true;
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
