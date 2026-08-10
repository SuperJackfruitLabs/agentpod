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
 * A station can host SEVERAL live sessions at once, so one controller is a view
 * onto one of them at a time:
 *   - `sessions` is the station's whole list in the hub's own order
 *     (newest-ACTIVITY-first from SQL — never re-sorted here, or a session that
 *     just streamed would sink below one idle since it was created). It is
 *     refreshed after a create and after an end, and the attached row is kept
 *     fresh in place from the stream's `session` frames.
 *   - `attach(id)` switches which one is on screen: close this socket, drop the
 *     transcript, subscribe to that session from seq 0. It is NAVIGATION — it
 *     ends nothing, exactly like `destroy()`.
 *   - `newSession()` is an explicit create-and-attach (that is how a second
 *     concurrent session is started). `prompt()` ALSO creates lazily when
 *     nothing is attached — that path stays, because it is what makes the empty
 *     state work with one keystroke, and both routes run through the same
 *     `#creating` window so `busy` (and the composer) stay honest.
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
 * (replay will never happen), the session ending, a switch away from its session
 * (dropped with the transcript — see `discardPendingPrompt`), or — the backstop
 * for a socket NOTHING has noticed is dead — the echo deadline
 * (ECHO_DEADLINE_MS). Every event-driven path needs an event; a slept laptop's
 * socket produces none.
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
const GONE_SESSION_COPY = "Couldn't open that session — it's no longer there.";

/**
 * How long an optimistic prompt may wait for its echo before we call it lost.
 *
 * The hub PERSISTS `user-prompt` before dispatching to the agent, so a healthy
 * echo comes back sub-second — 20s is generous headroom for a slow link, not a
 * guess at agent latency (the agent's own thinking happens after the echo).
 * This is the only release path that needs no inbound event, which is exactly
 * the case it exists for: a socket the browser still calls OPEN after a sleep,
 * where no close/error/reconnect/replay-done/bye is ever coming. The cost of a
 * false positive is small and reversible — the text returns to the composer and
 * the user re-sends — while the cost of not having it is a wedged composer with
 * no recovery short of a page reload.
 */
export const ECHO_DEADLINE_MS = 20_000;

let echoDeadlineMs: number = ECHO_DEADLINE_MS;

/** Test hook: shrink the echo deadline (mirrors the hub's `_set…ForTest` hooks). */
export function _setEchoDeadlineMsForTest(ms: number): void {
  echoDeadlineMs = ms;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export class AcpChat {
  // ── Reactive state ($state-backed, exposed via getters) ────────────────────
  #session = $state<AcpSessionRow | null>(null);
  /** The station's sessions in the hub's order. Never re-sorted locally. */
  #sessions = $state<AcpSessionRow[]>([]);
  #transcript = $state<Transcript>(emptyTranscript());
  #connection = $state<ChatConnection>("idle");
  #error = $state<string | null>(null);

  /** Mode selector state; defaults "ask", synced from the session row. */
  mode = $state<AcpSessionMode>("ask");

  // ── Plain (non-reactive) refs — timers and the live socket ────────────────
  private readonly stationId: string;
  private socket: AcpSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Armed when a prompt frame is written, disarmed by whatever resolves it. The
   * ONE release path that doesn't wait on an inbound event — see
   * ECHO_DEADLINE_MS. Must never outlive the pending prompt (a stray timer would
   * release a LATER prompt, or fire after destroy()).
   */
  private echoTimer: ReturnType<typeof setTimeout> | null = null;
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

  /**
   * Every session this user has on the station, in the hub's order
   * (newest-activity-first). Feeds the header's switcher; the attached one is
   * `session`. Ended sessions stay in the list — their transcripts are still
   * worth reading, and `attach` replays them read-only.
   */
  get sessions(): AcpSessionRow[] {
    return this.#sessions;
  }

  /**
   * True while a create POST is in flight (either route: `newSession()` or
   * `prompt()`'s lazy create). Exposed only so the "New session" button can
   * disable itself for that window — it is already folded into `busy`, so the
   * composer's refusal rule needs nothing extra.
   */
  get creating(): boolean {
    return this.#creating;
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

  /**
   * List the station's sessions and attach the first live one. Only ended
   * sessions (or none at all) → stay idle with the empty state, but the list is
   * still published so the switcher can offer their transcripts.
   */
  async init(): Promise<void> {
    let rows: AcpSessionRow[];
    try {
      rows = await listAcpSessions(this.stationId);
    } catch (err) {
      this.#error = errMessage(err);
      return;
    }
    if (this.destroyed) return;
    this.#sessions = rows;

    // Server order is authoritative (hub SQL: lastEventAt desc, id desc), so
    // the first non-ended row IS the most recently active live session.
    const live = rows.find((row) => row.status !== "ended");
    if (!live) return;
    this.attachRow(live);
  }

  /**
   * Switch to another of the station's sessions: close this socket, drop this
   * transcript, subscribe to that one from the start.
   *
   * NAVIGATION, not lifecycle — nothing is ended, here or on the hub (the same
   * contract as `destroy()`). The id is resolved against `sessions` first and
   * the list is re-read once before giving up, so a stale pick can't take the
   * live session's socket down with it.
   */
  async attach(sessionId: string): Promise<void> {
    if (this.destroyed) return;
    if (this.#session?.id === sessionId) return; // already on it — leave the socket alone

    let row = this.#sessions.find((s) => s.id === sessionId);
    if (!row) {
      await this.refreshSessions();
      if (this.destroyed) return;
      row = this.#sessions.find((s) => s.id === sessionId);
    }
    if (!row) {
      this.#error = GONE_SESSION_COPY;
      return;
    }
    this.attachRow(row);
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
      const row = await this.createSession();
      if (row === null) return;
      this.attachRow(row);
      // The list is a secondary surface here — the prompt frame must not wait on
      // a GET, so the new row goes in optimistically and the refresh lands late.
      void this.refreshSessions();
    } else if (!this.socket || !this.socket.isOpen) {
      // No socket (e.g. after budget exhaustion), or one that is CONNECTING /
      // CLOSING / CLOSED: either way there is nothing here that can carry a
      // frame and answer it, so redial rather than write into it. A socket the
      // browser has already noticed is gone still looks live to us until a close
      // event arrives — and after a laptop sleep that event may never come.
      // Tear the stale one down first: its close is ours, not a drop to
      // reconnect from. The new socket buffers pre-open sends, so subscribe
      // still precedes the prompt.
      this.clearReconnectTimer();
      this.teardownSocket();
      this.attempt = 0;
      this.startConnection();
    }

    this.#transcript = addPendingPrompt(this.#transcript, text);
    this.socket?.send({ t: "prompt", text });
    this.awaitingEcho = true;
    this.promptSocket = this.socket;
    // Nothing above proves the frame LANDED — only the echo does. Arm the
    // backstop even if `send` went nowhere.
    this.armEchoDeadline();
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
      return;
    }
    // The ended state arrives via the event stream (state: ended → bye);
    // nothing is forced locally. The LIST does need re-reading, though — the
    // switcher would otherwise keep offering this one as live.
    await this.refreshSessions();
  }

  /**
   * Start another session on the station and switch to it.
   *
   * A real create (the station can host several at once), not the old local
   * reset — so it borrows `prompt()`'s create window: `#creating` makes `busy`
   * true for the POST, which is exactly the rule `prompt()` refuses on, and a
   * second click is a no-op rather than a second session.
   */
  async newSession(): Promise<void> {
    const row = await this.createSession();
    if (row === null) return;
    this.attachRow(row);
    await this.refreshSessions();
  }

  /**
   * POST a session inside the `#creating` window. Returns null when the create
   * failed (message already on `error`) or the panel went away mid-flight — the
   * caller must not touch the socket in either case: the session that IS
   * attached is still live and usable.
   */
  private async createSession(): Promise<AcpSessionRow | null> {
    if (this.destroyed || this.#creating) return null;
    this.#creating = true;
    try {
      const row = await createAcpSession(this.stationId, this.mode);
      return this.destroyed ? null : row;
    } catch (err) {
      // The ApiError message already carries the right "Couldn't …" grammar.
      this.#error = errMessage(err);
      return null;
    } finally {
      this.#creating = false;
    }
  }

  /**
   * Re-read the station's sessions. Failures are deliberately silent: this runs
   * behind create/end/attach, where the actionable message is the one those
   * paths already surfaced — overwriting it with a list error would tell the
   * user about the least important half of what just happened. The stale list
   * stays on screen and the next refresh fixes it.
   */
  private async refreshSessions(): Promise<void> {
    try {
      const rows = await listAcpSessions(this.stationId);
      if (this.destroyed) return;
      this.#sessions = rows;
    } catch {
      /* keep the list we have */
    }
  }

  /**
   * Update one row in place, or prepend it when it's new (a just-created session
   * has the newest activity, which is where the hub's order puts it anyway).
   * Never re-sorts: a list that reshuffles itself under the pointer is how a
   * user opens the wrong session.
   */
  private syncSessionRow(row: AcpSessionRow): void {
    const idx = this.#sessions.findIndex((s) => s.id === row.id);
    if (idx === -1) {
      this.#sessions = [row, ...this.#sessions];
      return;
    }
    const next = this.#sessions.slice();
    next[idx] = row;
    this.#sessions = next;
  }

  /**
   * Point the controller at `row`: tear this socket down, start that session's
   * transcript from scratch and subscribe from seq 0.
   *
   * The socket is replaced, never remounted around — the panel keeps one
   * controller for its whole life, so this is the ONE place a session swap
   * happens and the one place every per-session flag is reset. A manual
   * `teardownSocket()` fires no `onClose`, so the session we're leaving is never
   * reconnected to.
   */
  private attachRow(row: AcpSessionRow): void {
    this.clearReconnectTimer();
    this.discardPendingPrompt();
    this.teardownSocket();
    this.#session = row;
    this.mode = row.mode;
    this.#transcript = emptyTranscript();
    this.#error = null;
    this.sessionOver = false;
    this.attempt = 0;
    this.syncSessionRow(row);
    this.startConnection();
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
    this.clearEchoDeadline(); // an unmounted panel has no composer to hand text to
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
        // Keep the switcher's row for this session honest too — its <Status> is
        // read from the list, not from the attached transcript.
        this.syncSessionRow(msg.session);
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
      this.clearEchoDeadline(); // the echo is here; nothing left to time out
    }
  }

  /**
   * Drop a trailing optimistic prompt whose echo will never arrive and hand its
   * text back to the composer. Clears `busy`, so the composer is usable again.
   */
  private releasePendingPrompt(): void {
    // Unconditionally: every other release path lands here, so this is the one
    // place that guarantees the deadline can't fire behind them.
    this.clearEchoDeadline();
    this.awaitingEcho = false;
    this.promptSocket = null;
    const { transcript, text } = dropPendingPrompt(this.#transcript);
    if (text === null) return;
    this.#transcript = transcript;
    this.onPromptFailed?.(text);
  }

  /**
   * Forget a pending optimistic prompt WITHOUT handing its text back. The only
   * caller is `attachRow`, which replaces the transcript wholesale — so the
   * ghost bubble goes with it (nothing can leak into the session being attached)
   * and `busy` unlatches because `hasPendingPrompt()` reads the new, empty one.
   *
   * The text is NOT returned to the composer on purpose: the composer now points
   * at a different session, and re-offering words written for another agent one
   * Enter away from sending them is worse than dropping a copy the hub most
   * likely persisted (switch back and the replay shows it).
   */
  private discardPendingPrompt(): void {
    this.clearEchoDeadline();
    this.awaitingEcho = false;
    this.promptSocket = null;
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

  /**
   * Start the echo deadline for the prompt just written. The frame may have gone
   * into a socket that will never answer (see ECHO_DEADLINE_MS); when the clock
   * runs out, release the pending item so `busy` — and the composer with it —
   * comes back, and hand the text to the user rather than keep it hostage.
   */
  private armEchoDeadline(): void {
    this.clearEchoDeadline();
    this.echoTimer = setTimeout(() => {
      this.echoTimer = null;
      if (this.destroyed || !this.hasPendingPrompt()) return;
      this.releasePendingPrompt();
      // Same fate, same sentence as a replay that came back without the echo:
      // the hub never saw it, and the words are back in the composer.
      this.#error = LOST_PROMPT_COPY;
    }, echoDeadlineMs);
  }

  private clearEchoDeadline(): void {
    if (this.echoTimer !== null) {
      clearTimeout(this.echoTimer);
      this.echoTimer = null;
    }
  }

  /** Close and detach the current socket (manual close — fires no onClose). */
  private teardownSocket(): void {
    const s = this.socket;
    this.socket = null;
    s?.close();
  }
}
