"""AgentPod live events for Hermes harness stations.

A bridge-mode station streams because the hub runs its turn over ACP and sends
the reader's devices `dev.agentpod.stream.delta` as text arrives. A harness-mode
station is its own Matrix client, and the hub never sees its turn
(`inbound.ts` returns before it does), so nothing streams. Hermes will not
stream into Matrix on its own either: `run_turn.py` hard-codes Matrix to
buffer-only, one message at the end of the turn.

This plugin closes that gap from inside Hermes. It observes the turn through
plugin hooks and sends the reader the same three to-device events the hub
sends, with the same bodies and the same pacing
(`apps/hub/src/services/matrix-as/live.ts` and `outbound.ts`), so a client
cannot tell which side of the hub a station is on.

Everything here is best-effort, like the hub's live channel: unencrypted
to-device, no retries, every failure swallowed. The room message Hermes sends
at the end of the turn is untouched, and is what a reader keeps.

Fleet reports. The hub's fleet Live Activity (the Lock Screen card) hears
about a bridge-mode turn from the hub's own bridge; a harness-mode turn it
never sees. So the plugin also reports each turn's lifecycle — started, each
tool step with its counts, an approval asked and answered, finished with its
counts, and the event id of its answer — to the node's fleet socket
(`~/.agentpod/fleet.sock`), one JSON line per event. The node forwards it to
the hub over its authenticated connection; the hub decides whose card it
belongs on. A report carries no more text than the card shows: a step title
cut to 60 characters, a question cut to 120.

The answer's event id is not given to plugins by any Hermes hook. Hermes's
Matrix adapter logs it — `Matrix: sent event %s to %s` — the moment the send
returns, so a logging handler reads it from there, in process and without a
network call. If Hermes ever changes that line the only loss is the turn's
counts on the answer's push; the contract test pins it.

Threading. Hermes runs each stream hook on its own worker thread, and the
turn hooks inline on the agent's thread. Every hook here only enqueues; one
sender thread owns all state and does all I/O, in arrival order. That keeps
`pre_tool_call`, which Hermes fails closed on timeout, from ever waiting on
the network. Fleet reports have their own thread, so a slow homeserver never
delays a report, and a report never waits more than half a second on the
node.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import socket
import threading
import time
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

LIVE_DELTA_TYPE = "dev.agentpod.stream.delta"
THOUGHT_DELTA_TYPE = "dev.agentpod.thought.delta"
TOOL_UPDATE_TYPE = "dev.agentpod.tool.update"

# Sent on every request. Not cosmetic: id.agentpod.dev sits behind Cloudflare,
# which answers urllib's default `Python-urllib/3.x` with 403 (error 1010,
# browser-signature ban). That cost the first live trial every event it sent.
USER_AGENT = "agentpod-live/0.2.0 (Hermes plugin)"

# Mirrors `live.ts`: a boundary with enough behind it goes at once; anything
# else waits, until the backstop.
MIN_DELTA_CHARS = 24
MAX_DELTA_WAIT_S = 1.5

# A turn that never ends (a crash between hooks, an interrupt that skips
# `post_llm_call`) is closed after this long without activity, so a reader's
# live view does not hang forever and this process does not grow.
IDLE_TURN_S = 600.0

# The card's own bounds (packages/contract/src/fleet-live.ts): a report
# carries no more text than the card shows.
FLEET_STEP_MAX = 60
FLEET_QUESTION_MAX = 120

# How long after a turn ends its answer's send is looked for, and how long an
# approval waits for its prompt to be sent. Hermes sends both within moments.
ANSWER_WAIT_S = 30.0

# A report never waits longer than this on the node.
FLEET_SOCKET_TIMEOUT_S = 0.5

# What Hermes's Matrix adapter logs when a room message has been sent
# (`plugins/platforms/matrix/adapter.py` `send`), with (event_id, room_id).
SENT_EVENT_LOG = "Matrix: sent event %s to %s"

_BOUNDARY_SENTENCE = re.compile(r"[.!?…:;][\"')\]]?\s*$")
_BOUNDARY_NEWLINE = re.compile(r"\n\s*$")


def ends_at_boundary(text: str) -> bool:
    return bool(_BOUNDARY_SENTENCE.search(text) or _BOUNDARY_NEWLINE.search(text))


def should_send_delta(pending: str, seconds_since_previous: float) -> bool:
    if not pending:
        return False
    if seconds_since_previous >= MAX_DELTA_WAIT_S:
        return True
    return len(pending) >= MIN_DELTA_CHARS and ends_at_boundary(pending)


# ─── Per-turn state ──────────────────────────────────────────────────────────


@dataclass
class _Channel:
    """One cumulative text stream (answer or reasoning) and its send cursor."""

    text: str = ""
    seq: int = 0
    sent_chars: int = 0
    sent_at: float = 0.0

    def take(self, done: bool, now: float) -> Optional[str]:
        """The text to send now, or None. Advances the cursor when it sends."""
        pending = self.text[self.sent_chars:]
        if not done and not should_send_delta(pending, now - self.sent_at):
            return None
        # The last delta is worth sending with nothing new — it is what tells
        # the reader the live view is over — unless nothing was ever sent.
        if done and not pending and self.seq == 0:
            return None
        self.seq += 1
        self.sent_chars = len(self.text)
        self.sent_at = now
        return self.text


@dataclass
class _Turn:
    session_id: str
    turn_id: str
    room_id: str
    reader: str
    answer: _Channel = field(default_factory=_Channel)
    thought: _Channel = field(default_factory=_Channel)
    tool_seq: int = 0
    # tool_call_id -> (title, kind, locations), from the call's start.
    tools: Dict[str, tuple] = field(default_factory=dict)
    # Calls started without an id, per tool name, oldest first.
    anonymous: Dict[str, List[str]] = field(default_factory=dict)
    touched_at: float = 0.0
    # What reached the homeserver, for the one log line a turn gets.
    sent: Dict[str, int] = field(default_factory=dict)
    failures: int = 0
    first_error: str = ""

    @property
    def live_id(self) -> str:
        """The wire `session_id`.

        The turn id rather than Hermes's session id: a reader treats a new
        session id as a new turn, which is exactly right here, and it means a
        straggler from the last turn can never be mistaken for this one.
        """
        return self.turn_id or self.session_id

    def matches(self, turn_id: str) -> bool:
        return not turn_id or not self.turn_id or turn_id == self.turn_id


# ─── Tool presentation ───────────────────────────────────────────────────────


def _describe_tool(tool_name: str, args: Dict[str, Any]) -> tuple:
    """(title, kind, locations) the way Hermes's own ACP adapter shows the call.

    The bridge path gets its titles from that adapter, so reusing it keeps a
    harness station's tool rows word for word the same as a bridge station's.
    Imported lazily and optional: without it the row is plainer, not missing.
    """
    try:
        from acp_adapter.tools import build_tool_title, extract_locations, get_tool_kind

        locations = [str(loc.path) for loc in extract_locations(args) if getattr(loc, "path", None)]
        return build_tool_title(tool_name, args), str(get_tool_kind(tool_name)), locations
    except Exception:
        path = args.get("path") if isinstance(args, dict) else None
        return tool_name, None, [str(path)] if path else []


# ─── The emitter ─────────────────────────────────────────────────────────────

Send = Callable[[str, str, Dict[str, Any]], None]


class LiveEmitter:
    """Turns hook events into live events. Single-threaded by contract.

    `send(event_type, reader, content)` delivers one to-device event; `clock`
    returns seconds. Both are injected so the policy is testable without a
    homeserver or a sleep.
    """

    def __init__(self, send: Send, clock: Callable[[], float] = time.monotonic, own_user: str = ""):
        self._send = send
        self._clock = clock
        self._own_user = own_user
        self._turns: Dict[str, _Turn] = {}

    # Turn lifecycle ---------------------------------------------------------

    def begin(self, session_id: str, turn_id: str, room_id: str, reader: str) -> None:
        skip = (
            "no session id" if not session_id
            else f"no room id (got {room_id!r})" if not room_id.startswith("!")
            else f"no reader (got {reader!r})" if not reader.startswith("@")
            else "the reader is the agent itself" if reader == self._own_user
            else ""
        )
        if skip:
            logger.info("agentpod-live: not streaming turn %s: %s", turn_id or session_id, skip)
            return
        logger.info("agentpod-live: streaming turn %s in %s to %s", turn_id or session_id, room_id, reader)
        previous = self._turns.get(session_id)
        if previous is not None:
            self._finish(previous)
        self._turns[session_id] = _Turn(
            session_id=session_id, turn_id=turn_id, room_id=room_id, reader=reader, touched_at=self._clock()
        )

    def end(self, session_id: str, turn_id: str = "") -> None:
        turn = self._turns.get(session_id)
        if turn is None or not turn.matches(turn_id):
            return
        self._finish(turn)

    def expire(self) -> None:
        cutoff = self._clock() - IDLE_TURN_S
        for turn in [t for t in self._turns.values() if t.touched_at < cutoff]:
            self._finish(turn)

    def _finish(self, turn: _Turn) -> None:
        self._turns.pop(turn.session_id, None)
        now = self._clock()
        self._emit_text(turn, turn.answer, LIVE_DELTA_TYPE, done=True, now=now)
        self._emit_text(turn, turn.thought, THOUGHT_DELTA_TYPE, done=True, now=now)
        sent = ", ".join(f"{k.rsplit('.', 2)[-2]}={v}" for k, v in sorted(turn.sent.items())) or "nothing"
        if turn.failures:
            logger.warning("agentpod-live: turn %s sent %s; %d send(s) failed, first: %s",
                           turn.live_id, sent, turn.failures, turn.first_error)
        else:
            logger.info("agentpod-live: turn %s sent %s", turn.live_id, sent)

    # Text -------------------------------------------------------------------

    def delta(self, session_id: str, turn_id: str, text: str, kind: str) -> None:
        turn = self._live(session_id, turn_id)
        if turn is None or not text:
            return
        now = self._clock()
        if kind == "reasoning":
            turn.thought.text += text
            self._emit_text(turn, turn.thought, THOUGHT_DELTA_TYPE, done=False, now=now)
        else:
            turn.answer.text += text
            self._emit_text(turn, turn.answer, LIVE_DELTA_TYPE, done=False, now=now)

    def _emit_text(self, turn: _Turn, channel: _Channel, event_type: str, *, done: bool, now: float) -> None:
        text = channel.take(done, now)
        if text is None:
            return
        self._deliver(turn, event_type, {
            "room_id": turn.room_id,
            "session_id": turn.live_id,
            "seq": channel.seq,
            "text": text,
            "done": done,
        })

    # Tools ------------------------------------------------------------------

    def tool_started(self, session_id: str, turn_id: str, tool_call_id: str, tool_name: str, args: Any) -> None:
        turn = self._live(session_id, turn_id)
        if turn is None:
            return
        args = args if isinstance(args, dict) else {}
        if not tool_call_id:
            tool_call_id = f"tc-{uuid.uuid4().hex[:12]}"
            turn.anonymous.setdefault(tool_name, []).append(tool_call_id)
        turn.tools[tool_call_id] = _describe_tool(tool_name, args)
        self._emit_tool(turn, tool_call_id, "in_progress")

    def tool_finished(
        self, session_id: str, turn_id: str, tool_call_id: str, tool_name: str, args: Any, failed: bool
    ) -> None:
        turn = self._live(session_id, turn_id)
        if turn is None:
            return
        if not tool_call_id:
            waiting = turn.anonymous.get(tool_name) or []
            tool_call_id = waiting.pop(0) if waiting else f"tc-{uuid.uuid4().hex[:12]}"
        if tool_call_id not in turn.tools:
            turn.tools[tool_call_id] = _describe_tool(tool_name, args if isinstance(args, dict) else {})
        self._emit_tool(turn, tool_call_id, "failed" if failed else "completed")

    def _emit_tool(self, turn: _Turn, tool_call_id: str, status: str) -> None:
        title, kind, locations = turn.tools[tool_call_id]
        turn.tool_seq += 1
        content: Dict[str, Any] = {
            "room_id": turn.room_id,
            "session_id": turn.live_id,
            "seq": turn.tool_seq,
            "tool_call_id": tool_call_id,
            "title": title,
            "status": status,
            "locations": list(locations),
        }
        # Omitted rather than empty, as `toolUpdateContent` does.
        if kind:
            content["kind"] = kind
        self._deliver(turn, TOOL_UPDATE_TYPE, content)

    # Plumbing ---------------------------------------------------------------

    def _live(self, session_id: str, turn_id: str) -> Optional[_Turn]:
        turn = self._turns.get(session_id)
        if turn is None or not turn.matches(turn_id):
            # A straggler from a turn that already ended, or a turn outside
            # Matrix. Either way there is no reader to tell.
            return None
        turn.touched_at = self._clock()
        return turn

    def _deliver(self, turn: _Turn, event_type: str, content: Dict[str, Any]) -> None:
        try:
            self._send(event_type, turn.reader, content)
            turn.sent[event_type] = turn.sent.get(event_type, 0) + 1
        except Exception as exc:
            turn.failures += 1
            if not turn.first_error:
                turn.first_error = f"{event_type}: {exc}"


# ─── Fleet reports ───────────────────────────────────────────────────────────


def bound(text: str, limit: int) -> str:
    """One line, at most `limit` characters, cut with an ellipsis — the card's rule."""
    line = " ".join(str(text).split())
    if len(line) <= limit:
        return line
    return line[: limit - 1].rstrip() + "…"


def _skip_reason(session_id: str, room_id: str, reader: str, own_user: str) -> str:
    return (
        "no session id" if not session_id
        else f"no room id (got {room_id!r})" if not room_id.startswith("!")
        else f"no reader (got {reader!r})" if not reader.startswith("@")
        else "the reader is the agent itself" if reader == own_user
        else ""
    )


@dataclass
class _FleetTurn:
    session_id: str
    turn_id: str
    room_id: str
    reader: str
    # tool_call_id -> (title, status), in call order.
    tools: Dict[str, List[str]] = field(default_factory=dict)
    anonymous: Dict[str, List[str]] = field(default_factory=dict)
    touched_at: float = 0.0

    def matches(self, turn_id: str) -> bool:
        return not turn_id or not self.turn_id or turn_id == self.turn_id

    def counts(self) -> tuple:
        statuses = [status for _, status in self.tools.values()]
        done = sum(1 for s in statuses if s in ("completed", "failed"))
        return done, len(statuses)


Report = Callable[[Dict[str, Any]], None]


class FleetReporter:
    """Turns hook events into fleet reports for the node. Single-threaded by contract.

    `report(dict)` delivers one report; `clock` is monotonic seconds and `wall`
    epoch seconds (the report's `at`, which the hub uses only to drop stale
    reports). All injected, so the policy is testable without a node.
    """

    def __init__(self, report: Report, own_user: str, clock: Callable[[], float] = time.monotonic,
                 wall: Callable[[], float] = time.time):
        self._report = report
        self._own_user = own_user
        self._clock = clock
        self._wall = wall
        self._turns: Dict[str, _FleetTurn] = {}
        # room -> (reader, total, failed, deadline): a finished turn whose answer is not sent yet.
        self._awaiting_answer: Dict[str, tuple] = {}
        # room -> (reader, question, deadline): an approval whose prompt is not sent yet.
        self._awaiting_prompt: Dict[str, tuple] = {}
        # room -> reader: an approval shown on the card.
        self._asked: Dict[str, str] = {}
        self.failures = 0
        self.first_error = ""

    # Turn lifecycle ---------------------------------------------------------

    def begin(self, session_id: str, turn_id: str, room_id: str, reader: str) -> None:
        # The live stream logs why a turn is skipped; the same turns are skipped here.
        if _skip_reason(session_id, room_id, reader, self._own_user):
            return
        previous = self._turns.get(session_id)
        if previous is not None:
            self._finish(previous)
        turn = _FleetTurn(session_id=session_id, turn_id=turn_id, room_id=room_id, reader=reader,
                          touched_at=self._clock())
        self._turns[session_id] = turn
        self._send(turn.room_id, turn.reader, {"type": "turn-started"})

    def end(self, session_id: str, turn_id: str = "") -> None:
        turn = self._turns.get(session_id)
        if turn is None or not turn.matches(turn_id):
            return
        self._finish(turn)

    def expire(self) -> None:
        now = self._clock()
        cutoff = now - IDLE_TURN_S
        for turn in [t for t in self._turns.values() if t.touched_at < cutoff]:
            # A turn that never ended is not shown as done.
            self._finish(turn, errored=True)
        for waiting in (self._awaiting_answer, self._awaiting_prompt):
            for room in [r for r, v in waiting.items() if v[-1] < now]:
                waiting.pop(room, None)

    def _finish(self, turn: _FleetTurn, errored: bool = False) -> None:
        self._turns.pop(turn.session_id, None)
        self._awaiting_prompt.pop(turn.room_id, None)
        if self._asked.pop(turn.room_id, None) is not None:
            self._send(turn.room_id, turn.reader, {"type": "decision-cleared"})
        statuses = [status for _, status in turn.tools.values()]
        total = len(statuses)
        failed = sum(1 for s in statuses if s == "failed")
        event: Dict[str, Any] = {"type": "turn-finished", "total": total, "failed": failed}
        if failed:
            event["failedAt"] = statuses.index("failed") + 1
        if errored:
            event["errored"] = True
        self._send(turn.room_id, turn.reader, event)
        # A turn that ran tools gets its counts on its answer's push (A5).
        if total and not errored:
            self._awaiting_answer[turn.room_id] = (turn.reader, total, failed, self._clock() + ANSWER_WAIT_S)

    # Tools ------------------------------------------------------------------

    def tool_started(self, session_id: str, turn_id: str, tool_call_id: str, tool_name: str, args: Any) -> None:
        turn = self._live(session_id, turn_id)
        if turn is None:
            return
        if not tool_call_id:
            tool_call_id = f"tc-{uuid.uuid4().hex[:12]}"
            turn.anonymous.setdefault(tool_name, []).append(tool_call_id)
        title = _describe_tool(tool_name, args if isinstance(args, dict) else {})[0]
        turn.tools[tool_call_id] = [title, "in_progress"]
        self._step(turn, title)

    def tool_finished(self, session_id: str, turn_id: str, tool_call_id: str, tool_name: str, args: Any,
                      failed: bool) -> None:
        turn = self._live(session_id, turn_id)
        if turn is None:
            return
        if not tool_call_id:
            waiting = turn.anonymous.get(tool_name) or []
            tool_call_id = waiting.pop(0) if waiting else f"tc-{uuid.uuid4().hex[:12]}"
        if tool_call_id not in turn.tools:
            title = _describe_tool(tool_name, args if isinstance(args, dict) else {})[0]
            turn.tools[tool_call_id] = [title, "in_progress"]
        turn.tools[tool_call_id][1] = "failed" if failed else "completed"
        self._step(turn, turn.tools[tool_call_id][0])

    def _step(self, turn: _FleetTurn, title: str) -> None:
        completed, total = turn.counts()
        self._send(turn.room_id, turn.reader, {"type": "step", "title": bound(title, FLEET_STEP_MAX),
                                               "completed": completed, "total": total})

    # Approvals --------------------------------------------------------------

    def approval_asked(self, session_id: str, turn_id: str, question: str) -> None:
        turn = self._live(session_id, turn_id)
        if turn is None:
            return
        # Reported once the prompt is in the room, so the card can open it.
        self._awaiting_prompt[turn.room_id] = (turn.reader, bound(question or "Approval needed", FLEET_QUESTION_MAX),
                                               self._clock() + ANSWER_WAIT_S)

    def approval_answered(self, session_id: str, turn_id: str) -> None:
        turn = self._live(session_id, turn_id)
        if turn is None:
            return
        self._awaiting_prompt.pop(turn.room_id, None)
        if self._asked.pop(turn.room_id, None) is not None:
            self._send(turn.room_id, turn.reader, {"type": "decision-cleared"})

    # What Hermes sent -------------------------------------------------------

    def sent(self, room_id: str, event_id: str) -> None:
        """A room message the agent sent, as Hermes's Matrix adapter logged it."""
        now = self._clock()
        if not event_id.startswith("$"):
            return
        prompt = self._awaiting_prompt.pop(room_id, None)
        if prompt is not None and prompt[-1] >= now:
            reader, question, _ = prompt
            self._asked[room_id] = reader
            self._send(room_id, reader, {"type": "decision-asked", "eventId": event_id, "question": question})
            return
        answer = self._awaiting_answer.pop(room_id, None)
        if answer is not None and answer[-1] >= now:
            reader, total, failed, _ = answer
            self._send(room_id, reader, {"type": "answer", "eventId": event_id, "total": total, "failed": failed})

    # Plumbing ---------------------------------------------------------------

    def _live(self, session_id: str, turn_id: str) -> Optional[_FleetTurn]:
        turn = self._turns.get(session_id)
        if turn is None or not turn.matches(turn_id):
            return None
        turn.touched_at = self._clock()
        return turn

    def _send(self, room_id: str, reader: str, event: Dict[str, Any]) -> None:
        report = {"agent": self._own_user, "roomId": room_id, "reader": reader,
                  "at": int(self._wall() * 1000), "event": event}
        try:
            self._report(report)
        except Exception as exc:
            self.failures += 1
            if not self.first_error:
                self.first_error = f"{event.get('type')}: {exc}"
                # Once per process: a node without the fleet socket is a
                # fact about the node, not news on every turn.
                logger.info("agentpod-live: fleet report not delivered (%s); the card will not show this agent",
                            self.first_error)


def fleet_socket_path() -> str:
    override = os.environ.get("AGENTPOD_FLEET_SOCKET", "").strip()
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".agentpod", "fleet.sock")


def fleet_socket_sender(path: str, timeout_s: float = FLEET_SOCKET_TIMEOUT_S) -> Report:
    """One JSON line to the node's fleet socket; the node answers `ok` or `error: …`."""

    def send(report: Dict[str, Any]) -> None:
        line = (json.dumps(report, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(timeout_s)
            conn.connect(path)
            conn.sendall(line)
            reply = conn.recv(512).decode("utf-8", "replace").strip()
        if reply != "ok":
            raise RuntimeError(reply or "no answer")

    return send


class _SentEventTap(logging.Handler):
    """Reads each sent room message's event id off Hermes's Matrix adapter log line."""

    def __init__(self, on_sent: Callable[[str, str], None]):
        super().__init__(level=logging.INFO)
        self._on_sent = on_sent

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = record.msg
            if not isinstance(msg, str) or not msg.startswith(SENT_EVENT_LOG):
                return
            args = record.args
            if not isinstance(args, tuple) or len(args) < 2:
                return
            self._on_sent(str(args[1]), str(args[0]))
        except Exception:
            pass


# ─── Matrix ──────────────────────────────────────────────────────────────────


def matrix_sender(homeserver: str, access_token: str, timeout_s: float = 5.0) -> Send:
    """`PUT /sendToDevice` as the agent, to every device of the reader."""
    base = homeserver.rstrip("/")

    def send(event_type: str, reader: str, content: Dict[str, Any]) -> None:
        txn = uuid.uuid4().hex
        url = f"{base}/_matrix/client/v3/sendToDevice/{urllib.parse.quote(event_type)}/{txn}"
        body = json.dumps({"messages": {reader: {"*": content}}}).encode("utf-8")
        request = urllib.request.Request(url, data=body, method="PUT", headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        })
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            response.read()

    return send


# ─── Hermes wiring ───────────────────────────────────────────────────────────


class _Worker:
    """One daemon thread that runs every emitter call in arrival order."""

    def __init__(self, emitter: Any, name: str = "agentpod-live"):
        self.emitter = emitter
        self.events: "queue.Queue[tuple]" = queue.Queue(maxsize=4096)
        threading.Thread(target=self._run, daemon=True, name=name).start()

    def put(self, method: str, *args: Any) -> None:
        try:
            self.events.put_nowait((method, args))
        except queue.Full:
            # Dropping a delta costs a reader some smoothness; blocking would
            # cost the agent its turn.
            pass

    def _run(self) -> None:
        while True:
            try:
                method, args = self.events.get(timeout=30)
            except queue.Empty:
                self.emitter.expire()
                continue
            try:
                getattr(self.emitter, method)(*args)
            except Exception as exc:
                logger.debug("agentpod-live: %s failed: %s", method, exc)


def _session_env(name: str) -> str:
    try:
        from gateway.session_context import get_session_env

        return get_session_env(name, "") or ""
    except Exception:
        return os.environ.get(name, "")


def _failed(status: Any, error_type: Any) -> bool:
    return bool(error_type) or str(status or "").lower() in ("error", "failed", "failure")


def register(ctx: Any) -> None:
    homeserver = os.environ.get("MATRIX_HOMESERVER", "")
    token = os.environ.get("MATRIX_ACCESS_TOKEN", "")
    if not homeserver or not token:
        # Registering a stream hook makes Hermes stream every model call, so
        # a plugin with nowhere to send must not register one.
        logger.info("agentpod-live: MATRIX_HOMESERVER or MATRIX_ACCESS_TOKEN unset; not registering")
        return

    own_user = os.environ.get("MATRIX_USER_ID", "")
    worker = _Worker(LiveEmitter(matrix_sender(homeserver, token), own_user=own_user))
    logger.info("agentpod-live: registered; sending to %s", urllib.parse.urlsplit(homeserver).netloc or homeserver)

    # The fleet card needs to know who is reporting; without our own Matrix
    # id the hub could not place a report, so none is made.
    fleet: Optional[_Worker] = None
    if own_user.startswith("@"):
        path = fleet_socket_path()
        fleet = _Worker(FleetReporter(fleet_socket_sender(path), own_user=own_user), name="agentpod-fleet")
        tap = _SentEventTap(lambda room_id, event_id: fleet.put("sent", room_id, event_id))
        logging.getLogger().addHandler(tap)
        logger.info("agentpod-live: reporting turns to the fleet card via %s", path)
    else:
        logger.info("agentpod-live: MATRIX_USER_ID unset; turns are streamed but not reported to the fleet card")

    def both(method: str, *args: Any) -> None:
        worker.put(method, *args)
        if fleet is not None:
            fleet.put(method, *args)

    def pre_llm_call(session_id: str = "", turn_id: str = "", platform: str = "", sender_id: str = "", **_: Any):
        if str(platform).lower() != "matrix":
            return None
        # Read here, inline: the session's context variables are bound on
        # this thread and not on Hermes's stream workers.
        room_id = _session_env("HERMES_SESSION_CHAT_ID")
        reader = _session_env("HERMES_SESSION_USER_ID") or sender_id
        both("begin", session_id or "", turn_id or "", room_id, reader or "")
        return None

    def post_llm_call(session_id: str = "", turn_id: str = "", **_: Any):
        both("end", session_id or "", turn_id or "")
        return None

    def on_stream_delta(delta: str = "", kind: str = "text", session_id: str = "", turn_id: str = "", **_: Any):
        worker.put("delta", session_id or "", turn_id or "", delta or "", kind or "text")

    def pre_tool_call(tool_name: str = "", args: Any = None, session_id: str = "", turn_id: str = "",
                      tool_call_id: str = "", **_: Any):
        both("tool_started", session_id or "", turn_id or "", tool_call_id or "", tool_name, args)
        return None

    def post_tool_call(tool_name: str = "", args: Any = None, session_id: str = "", turn_id: str = "",
                       tool_call_id: str = "", status: Any = None, error_type: Any = None, **_: Any):
        both("tool_finished", session_id or "", turn_id or "", tool_call_id or "", tool_name, args,
             _failed(status, error_type))

    def pre_approval_request(command: Any = "", description: Any = "", session_id: str = "", turn_id: str = "",
                             **_: Any):
        if fleet is not None:
            fleet.put("approval_asked", session_id or "", turn_id or "", str(description or command or ""))
        return None

    def post_approval_response(session_id: str = "", turn_id: str = "", **_: Any):
        if fleet is not None:
            fleet.put("approval_answered", session_id or "", turn_id or "")
        return None

    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_llm_call", post_llm_call)
    ctx.register_hook("on_stream_delta", on_stream_delta)
    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("post_tool_call", post_tool_call)
    if fleet is not None:
        ctx.register_hook("pre_approval_request", pre_approval_request)
        ctx.register_hook("post_approval_response", post_approval_response)
