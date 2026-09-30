"""Tests for the agentpod-live Hermes plugin. Stdlib only: `python3 -m unittest`."""

import importlib.util
import json
import logging
import os
import pathlib
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

_HERE = pathlib.Path(__file__).parent
_spec = importlib.util.spec_from_file_location("agentpod_live", _HERE / "__init__.py")
live = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = live
_spec.loader.exec_module(live)

ROOM = "!room:id.agentpod.dev"
READER = "@rakesh:id.agentpod.dev"
AGENT = "@agent_strategy-sam:id.agentpod.dev"


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


class Harness:
    def __init__(self):
        self.sent = []
        self.clock = Clock()
        self.emitter = live.LiveEmitter(
            lambda t, r, c: self.sent.append((t, r, c)), clock=self.clock, own_user=AGENT
        )

    def of(self, event_type):
        return [c for t, _, c in self.sent if t == event_type]


class PacingTest(unittest.TestCase):
    def test_boundary_policy_matches_the_hub(self):
        self.assertFalse(live.should_send_delta("", 10))
        self.assertFalse(live.should_send_delta("Short.", 0))
        self.assertTrue(live.should_send_delta("This sentence is long enough.", 0))
        self.assertFalse(live.should_send_delta("This sentence is long enough, but", 0))
        self.assertTrue(live.should_send_delta("no boundary at all", 1.5))
        self.assertTrue(live.ends_at_boundary('He said "done."'))
        self.assertTrue(live.ends_at_boundary("a line\n"))
        self.assertFalse(live.ends_at_boundary("a clause,"))


class AnswerStreamTest(unittest.TestCase):
    def test_cumulative_text_with_monotonic_seq_and_a_final_done(self):
        h = Harness()
        h.emitter.begin("s1", "t1", ROOM, READER)
        h.emitter.delta("s1", "t1", "Hello there, this is the first sentence.", "text")
        h.emitter.delta("s1", "t1", " And a", "text")
        h.emitter.delta("s1", "t1", " second one that ends.", "text")
        h.emitter.end("s1", "t1")

        deltas = h.of(live.LIVE_DELTA_TYPE)
        self.assertEqual([d["seq"] for d in deltas], [1, 2, 3])
        self.assertEqual([d["done"] for d in deltas], [False, False, True])
        self.assertEqual(deltas[1]["text"], "Hello there, this is the first sentence. And a second one that ends.")
        self.assertEqual(deltas[2]["text"], deltas[1]["text"])
        for d in deltas:
            self.assertEqual(d["room_id"], ROOM)
            self.assertEqual(d["session_id"], "t1")
        self.assertTrue(all(r == READER for _, r, _ in h.sent))

    def test_held_text_waits_for_the_backstop(self):
        h = Harness()
        h.emitter.begin("s1", "t1", ROOM, READER)
        h.emitter.delta("s1", "t1", "Opening words that are long enough.", "text")
        h.emitter.delta("s1", "t1", " then more without an end", "text")
        self.assertEqual(len(h.of(live.LIVE_DELTA_TYPE)), 1)
        h.clock.now += 1.6
        h.emitter.delta("s1", "t1", " still going", "text")
        self.assertEqual(len(h.of(live.LIVE_DELTA_TYPE)), 2)

    def test_reasoning_goes_on_its_own_channel(self):
        h = Harness()
        h.emitter.begin("s1", "t1", ROOM, READER)
        h.emitter.delta("s1", "t1", "Let me think about the question first.", "reasoning")
        h.emitter.delta("s1", "t1", "The answer is forty-two, as expected.", "text")
        h.emitter.end("s1", "t1")
        thoughts = h.of(live.THOUGHT_DELTA_TYPE)
        answers = h.of(live.LIVE_DELTA_TYPE)
        self.assertEqual(thoughts[-1]["text"], "Let me think about the question first.")
        self.assertTrue(thoughts[-1]["done"])
        self.assertNotIn("think", answers[-1]["text"])

    def test_a_turn_that_never_spoke_sends_no_done(self):
        h = Harness()
        h.emitter.begin("s1", "t1", ROOM, READER)
        h.emitter.end("s1", "t1")
        self.assertEqual(h.sent, [])


class TurnBoundaryTest(unittest.TestCase):
    def test_a_straggler_after_the_end_is_dropped(self):
        # Hermes delivers deltas on a worker thread; one can land after
        # post_llm_call. Resurrecting the live view would leave a ghost bubble.
        h = Harness()
        h.emitter.begin("s1", "t1", ROOM, READER)
        h.emitter.delta("s1", "t1", "A complete sentence, sent at once.", "text")
        h.emitter.end("s1", "t1")
        count = len(h.sent)
        h.emitter.delta("s1", "t1", " late words that arrive after.", "text")
        self.assertEqual(len(h.sent), count)

    def test_the_last_turns_straggler_does_not_leak_into_the_next(self):
        h = Harness()
        h.emitter.begin("s1", "t1", ROOM, READER)
        h.emitter.end("s1", "t1")
        h.emitter.begin("s1", "t2", ROOM, READER)
        h.emitter.delta("s1", "t1", "Old text from the previous turn.", "text")
        h.emitter.delta("s1", "t2", "New text for the current turn.", "text")
        deltas = h.of(live.LIVE_DELTA_TYPE)
        self.assertEqual(len(deltas), 1)
        self.assertEqual(deltas[0]["session_id"], "t2")
        self.assertEqual(deltas[0]["seq"], 1)

    def test_a_new_turn_closes_one_that_never_ended(self):
        h = Harness()
        h.emitter.begin("s1", "t1", ROOM, READER)
        h.emitter.delta("s1", "t1", "Interrupted before it could finish.", "text")
        h.emitter.begin("s1", "t2", ROOM, READER)
        deltas = h.of(live.LIVE_DELTA_TYPE)
        self.assertTrue(deltas[-1]["done"])
        self.assertEqual(deltas[-1]["session_id"], "t1")

    def test_an_idle_turn_expires(self):
        h = Harness()
        h.emitter.begin("s1", "t1", ROOM, READER)
        h.emitter.delta("s1", "t1", "Something said before going quiet.", "text")
        h.clock.now += live.IDLE_TURN_S + 1
        h.emitter.expire()
        self.assertTrue(h.of(live.LIVE_DELTA_TYPE)[-1]["done"])

    def test_non_matrix_or_self_addressed_turns_are_ignored(self):
        h = Harness()
        h.emitter.begin("s1", "t1", "", READER)
        h.emitter.begin("s2", "t2", ROOM, "")
        h.emitter.begin("s3", "t3", ROOM, AGENT)
        for s, t in (("s1", "t1"), ("s2", "t2"), ("s3", "t3"), ("nope", "")):
            h.emitter.delta(s, t, "A sentence that would otherwise send.", "text")
        self.assertEqual(h.sent, [])


class ToolTest(unittest.TestCase):
    def test_a_call_goes_in_progress_then_completed(self):
        h = Harness()
        h.emitter.begin("s1", "t1", ROOM, READER)
        h.emitter.tool_started("s1", "t1", "call_1", "read_file", {"path": "/srv/notes.md"})
        h.emitter.tool_finished("s1", "t1", "call_1", "read_file", {"path": "/srv/notes.md"}, False)
        updates = h.of(live.TOOL_UPDATE_TYPE)
        self.assertEqual([u["status"] for u in updates], ["in_progress", "completed"])
        self.assertEqual([u["seq"] for u in updates], [1, 2])
        self.assertEqual({u["tool_call_id"] for u in updates}, {"call_1"})
        self.assertEqual(updates[0]["locations"], ["/srv/notes.md"])
        self.assertTrue(updates[0]["title"].startswith("read_file"))

    def test_failure_and_missing_ids(self):
        h = Harness()
        h.emitter.begin("s1", "t1", ROOM, READER)
        h.emitter.tool_started("s1", "t1", "", "terminal", {"command": "false"})
        h.emitter.tool_finished("s1", "t1", "", "terminal", {"command": "false"}, True)
        updates = h.of(live.TOOL_UPDATE_TYPE)
        self.assertEqual(updates[0]["tool_call_id"], updates[1]["tool_call_id"])
        self.assertEqual(updates[1]["status"], "failed")

    def test_kind_is_omitted_when_unknown(self):
        h = Harness()
        h.emitter.begin("s1", "t1", ROOM, READER)
        with mock.patch.object(live, "_describe_tool", return_value=("custom", None, [])):
            h.emitter.tool_started("s1", "t1", "c", "custom", {})
        self.assertNotIn("kind", h.of(live.TOOL_UPDATE_TYPE)[0])

    def test_status_mapping(self):
        self.assertTrue(live._failed("error", None))
        self.assertTrue(live._failed("ok", "tool_error"))
        self.assertFalse(live._failed("ok", None))


class SendFailureTest(unittest.TestCase):
    def test_a_failed_send_never_raises(self):
        def boom(*_):
            raise OSError("homeserver down")

        emitter = live.LiveEmitter(boom, clock=Clock())
        emitter.begin("s1", "t1", ROOM, READER)
        emitter.delta("s1", "t1", "A sentence that tries to send.", "text")
        emitter.end("s1", "t1")


class LoggingTest(unittest.TestCase):
    def test_a_turn_logs_what_it_sent_and_why_it_skipped(self):
        h = Harness()
        with self.assertLogs(live.logger, "INFO") as logs:
            h.emitter.begin("s0", "t0", "", READER)
            h.emitter.begin("s1", "t1", ROOM, READER)
            h.emitter.delta("s1", "t1", "A sentence that sends right away.", "text")
            h.emitter.end("s1", "t1")
        text = "\n".join(logs.output)
        self.assertIn("not streaming turn t0: no room id", text)
        self.assertIn("turn t1 sent stream=2", text)

    def test_send_failures_are_warned_once_per_turn(self):
        def boom(*_):
            raise OSError("403 Forbidden")

        emitter = live.LiveEmitter(boom, clock=Clock())
        emitter.begin("s1", "t1", ROOM, READER)
        emitter.delta("s1", "t1", "A sentence that tries to send.", "text")
        with self.assertLogs(live.logger, "WARNING") as logs:
            emitter.end("s1", "t1")
        self.assertEqual(len(logs.output), 1)
        self.assertIn("2 send(s) failed, first: dev.agentpod.stream.delta: 403 Forbidden", logs.output[0])


class MatrixSenderTest(unittest.TestCase):
    def test_put_send_to_device_with_a_wildcard_device(self):
        seen = {}

        class Handler(BaseHTTPRequestHandler):
            def do_PUT(self):
                seen["path"] = self.path
                seen["auth"] = self.headers["Authorization"]
                seen["agent"] = self.headers["User-Agent"]
                seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.handle_request, daemon=True).start()
        send = live.matrix_sender(f"http://127.0.0.1:{server.server_port}/", "tok")
        send(live.LIVE_DELTA_TYPE, READER, {"seq": 1})
        server.server_close()

        self.assertTrue(seen["path"].startswith("/_matrix/client/v3/sendToDevice/dev.agentpod.stream.delta/"))
        self.assertEqual(seen["auth"], "Bearer tok")
        # Cloudflare 403s urllib's default agent; see USER_AGENT.
        self.assertFalse(seen["agent"].startswith("Python-urllib"), seen["agent"])
        self.assertEqual(seen["agent"], live.USER_AGENT)
        self.assertEqual(seen["body"], {"messages": {READER: {"*": {"seq": 1}}}})


class RegisterTest(unittest.TestCase):
    class Ctx:
        def __init__(self):
            self.hooks = {}

        def register_hook(self, name, fn):
            self.hooks[name] = fn

    def test_no_credentials_means_no_hooks(self):
        # A stream hook forces Hermes to stream every call; without somewhere
        # to send, registering one would be all cost.
        ctx = self.Ctx()
        with mock.patch.dict(live.os.environ, {}, clear=True):
            live.register(ctx)
        self.assertEqual(ctx.hooks, {})

    def test_hooks_route_a_matrix_turn_end_to_end(self):
        sent = []
        ctx = self.Ctx()
        env = {"MATRIX_HOMESERVER": "https://hs", "MATRIX_ACCESS_TOKEN": "tok", "MATRIX_USER_ID": AGENT,
               "HERMES_SESSION_CHAT_ID": ROOM, "HERMES_SESSION_USER_ID": READER,
               "AGENTPOD_FLEET_SOCKET": "/tmp/agentpod-live-test-no-node.sock"}
        root = logging.getLogger()
        before = list(root.handlers)
        self.addCleanup(lambda: [root.removeHandler(h) for h in list(root.handlers) if h not in before])
        with mock.patch.dict(live.os.environ, env, clear=True), \
                mock.patch.object(live, "matrix_sender", return_value=lambda t, r, c: sent.append((t, r, c))):
            live.register(ctx)
            self.assertEqual(set(ctx.hooks), {"pre_llm_call", "post_llm_call", "on_stream_delta",
                                              "pre_tool_call", "post_tool_call",
                                              "pre_approval_request", "post_approval_response"})
            self.assertIsNone(ctx.hooks["pre_llm_call"](session_id="s1", turn_id="t1", platform="matrix"))
            ctx.hooks["on_stream_delta"](delta="Streaming from a harness station.", kind="text",
                                         session_id="s1", turn_id="t1", telemetry_schema_version=1)
            self.assertIsNone(ctx.hooks["pre_tool_call"](tool_name="todo", args={}, session_id="s1",
                                                         turn_id="t1", tool_call_id="c1"))
            ctx.hooks["post_tool_call"](tool_name="todo", args={}, session_id="s1", turn_id="t1",
                                        tool_call_id="c1", status="ok")
            ctx.hooks["post_llm_call"](session_id="s1", turn_id="t1", assistant_response="x")
            ctx.hooks["pre_llm_call"](session_id="s2", turn_id="t9", platform="telegram")
            ctx.hooks["on_stream_delta"](delta="Not a Matrix turn, never sent.", session_id="s2", turn_id="t9")

            deadline = time.time() + 2
            while len(sent) < 4 and time.time() < deadline:
                time.sleep(0.01)
            time.sleep(0.05)

        types = [t for t, _, _ in sent]
        self.assertEqual(types, [live.LIVE_DELTA_TYPE, live.TOOL_UPDATE_TYPE, live.TOOL_UPDATE_TYPE,
                                 live.LIVE_DELTA_TYPE])
        self.assertTrue(sent[-1][2]["done"])

    def test_hooks_report_a_matrix_turn_to_the_node(self):
        node = _NodeSocket()
        self.addCleanup(node.close)
        ctx = self.Ctx()
        env = {"MATRIX_HOMESERVER": "https://hs", "MATRIX_ACCESS_TOKEN": "tok", "MATRIX_USER_ID": AGENT,
               "HERMES_SESSION_CHAT_ID": ROOM, "HERMES_SESSION_USER_ID": READER,
               "AGENTPOD_FLEET_SOCKET": node.path}
        root = logging.getLogger()
        before = list(root.handlers)
        self.addCleanup(lambda: [root.removeHandler(h) for h in list(root.handlers) if h not in before])
        adapter_log = logging.getLogger("plugins.platforms.matrix.adapter")
        adapter_log.setLevel(logging.INFO)
        with mock.patch.dict(live.os.environ, env, clear=True), \
                mock.patch.object(live, "matrix_sender", return_value=lambda t, r, c: None):
            live.register(ctx)
            ctx.hooks["pre_llm_call"](session_id="s1", turn_id="t1", platform="matrix")
            # Reasoning is the Thinking phase the turn starts in: no report.
            ctx.hooks["on_stream_delta"](delta="Should build", kind="reasoning", session_id="s1", turn_id="t1")
            ctx.hooks["pre_tool_call"](tool_name="terminal", args={"command": "make"}, session_id="s1",
                                       turn_id="t1", tool_call_id="c1")
            # A preamble's last words, landing after the tool call began: not writing yet.
            ctx.hooks["on_stream_delta"](delta="Building.", kind="text", session_id="s1", turn_id="t1")
            ctx.hooks["pre_approval_request"](command="make", description="Run make?", session_key="k",
                                              surface="gateway", session_id="s1", turn_id="t1")
            adapter_log.info("Matrix: sent event %s to %s", "$prompt", ROOM)
            ctx.hooks["post_approval_response"](command="make", description="Run make?", session_key="k",
                                                surface="gateway", choice="once", session_id="s1", turn_id="t1")
            ctx.hooks["post_tool_call"](tool_name="terminal", args={"command": "make"}, session_id="s1",
                                        turn_id="t1", tool_call_id="c1", status="ok")
            ctx.hooks["on_stream_delta"](delta="It built", kind="reasoning", session_id="s1", turn_id="t1")
            for word in ("The ", "build ", "passed."):
                ctx.hooks["on_stream_delta"](delta=word, kind="text", session_id="s1", turn_id="t1")
            ctx.hooks["post_llm_call"](session_id="s1", turn_id="t1", assistant_response="done")
            adapter_log.info("Matrix: sent event %s to %s", "$answer", ROOM)

            deadline = time.time() + 3
            while len(node.lines) < 8 and time.time() < deadline:
                time.sleep(0.01)

        types = [line["event"]["type"] for line in node.lines]
        self.assertEqual(types, ["turn-started", "step", "decision-asked", "decision-cleared", "step",
                                 "writing", "turn-finished", "answer"])
        self.assertEqual(node.lines[5]["event"], {"type": "writing"})
        self.assertEqual(node.lines[2]["event"], {"type": "decision-asked", "eventId": "$prompt",
                                                  "question": "Run make?"})
        self.assertEqual(node.lines[-1]["event"], {"type": "answer", "eventId": "$answer", "total": 1,
                                                   "failed": 0})

    def test_each_turn_in_a_session_reports_its_own_writing(self):
        node = _NodeSocket()
        self.addCleanup(node.close)
        ctx = self.Ctx()
        env = {"MATRIX_HOMESERVER": "https://hs", "MATRIX_ACCESS_TOKEN": "tok", "MATRIX_USER_ID": AGENT,
               "HERMES_SESSION_CHAT_ID": ROOM, "HERMES_SESSION_USER_ID": READER,
               "AGENTPOD_FLEET_SOCKET": node.path}
        root = logging.getLogger()
        before = list(root.handlers)
        self.addCleanup(lambda: [root.removeHandler(h) for h in list(root.handlers) if h not in before])
        with mock.patch.dict(live.os.environ, env, clear=True), \
                mock.patch.object(live, "matrix_sender", return_value=lambda t, r, c: None):
            live.register(ctx)
            for turn in ("t1", "t2"):
                ctx.hooks["pre_llm_call"](session_id="s1", turn_id=turn, platform="matrix")
                ctx.hooks["on_stream_delta"](delta="Hi.", kind="text", session_id="s1", turn_id=turn)
                ctx.hooks["post_llm_call"](session_id="s1", turn_id=turn)

            deadline = time.time() + 3
            while len(node.lines) < 6 and time.time() < deadline:
                time.sleep(0.01)

        self.assertEqual([line["event"]["type"] for line in node.lines],
                         ["turn-started", "writing", "turn-finished"] * 2)

    def test_without_its_own_matrix_id_it_streams_but_does_not_report(self):
        ctx = self.Ctx()
        env = {"MATRIX_HOMESERVER": "https://hs", "MATRIX_ACCESS_TOKEN": "tok"}
        root = logging.getLogger()
        before = list(root.handlers)
        with mock.patch.dict(live.os.environ, env, clear=True), \
                mock.patch.object(live, "matrix_sender", return_value=lambda t, r, c: None):
            live.register(ctx)
        self.assertIn("on_stream_delta", ctx.hooks)
        self.assertNotIn("pre_approval_request", ctx.hooks)
        self.assertEqual(root.handlers, before)


# ─── Fleet reports: the hub's Live Activity, for a turn it never sees ────────


class Wall:
    def __init__(self):
        self.now = 1_790_000_000.0

    def __call__(self):
        return self.now


class FleetHarness:
    def __init__(self, fail=False):
        self.reports = []
        self.clock = Clock()
        self.wall = Wall()

        def report(r):
            if fail:
                raise OSError("no node")
            self.reports.append(r)

        self.reporter = live.FleetReporter(report, own_user=AGENT, clock=self.clock, wall=self.wall)

    def events(self):
        return [r["event"] for r in self.reports]


class FleetTurnTest(unittest.TestCase):
    def test_a_turn_reports_its_start_each_step_and_its_end_with_counts(self):
        h = FleetHarness()
        r = h.reporter
        r.begin("s1", "t1", ROOM, READER)
        r.tool_started("s1", "t1", "c1", "read_file", {"path": "/notes.md"})
        r.tool_finished("s1", "t1", "c1", "read_file", {"path": "/notes.md"}, False)
        r.tool_started("s1", "t1", "c2", "terminal", {"command": "make"})
        r.tool_finished("s1", "t1", "c2", "terminal", {"command": "make"}, True)
        r.end("s1", "t1")

        events = h.events()
        self.assertEqual([e["type"] for e in events],
                         ["turn-started", "step", "step", "step", "step", "turn-finished"])
        self.assertEqual([(e["completed"], e["total"]) for e in events if e["type"] == "step"],
                         [(0, 1), (1, 1), (1, 2), (2, 2)])
        self.assertEqual(events[-1], {"type": "turn-finished", "total": 2, "failed": 1, "failedAt": 2})
        for rep in h.reports:
            self.assertEqual(rep["agent"], AGENT)
            self.assertEqual(rep["roomId"], ROOM)
            self.assertEqual(rep["reader"], READER)
            self.assertEqual(rep["at"], 1_790_000_000_000)
            self.assertEqual(set(rep), {"agent", "roomId", "reader", "at", "event"})

    def test_a_turn_that_only_talked_finishes_with_no_counts(self):
        h = FleetHarness()
        h.reporter.begin("s1", "t1", ROOM, READER)
        h.reporter.end("s1", "t1")
        self.assertEqual(h.events()[-1], {"type": "turn-finished", "total": 0, "failed": 0})

    def test_a_step_carries_only_what_the_card_shows(self):
        h = FleetHarness()
        h.reporter.begin("s1", "t1", ROOM, READER)
        h.reporter.tool_started("s1", "t1", "c1", "x" * 200 + "\nsecond line", {})
        step = h.events()[-1]
        self.assertEqual(set(step), {"type", "title", "completed", "total"})
        self.assertLessEqual(len(step["title"]), live.FLEET_STEP_MAX)
        self.assertNotIn("\n", step["title"])
        self.assertTrue(step["title"].endswith("…"))

    def test_turns_the_live_stream_skips_are_not_reported(self):
        h = FleetHarness()
        h.reporter.begin("s1", "t1", "", READER)
        h.reporter.begin("s2", "t2", ROOM, AGENT)
        h.reporter.begin("s3", "t3", ROOM, "")
        h.reporter.tool_started("s1", "t1", "c1", "todo", {})
        h.reporter.end("s2", "t2")
        self.assertEqual(h.reports, [])

    def test_an_idle_turn_is_finished_as_errored(self):
        h = FleetHarness()
        h.reporter.begin("s1", "t1", ROOM, READER)
        h.clock.now += live.IDLE_TURN_S + 1
        h.reporter.expire()
        self.assertEqual(h.events()[-1], {"type": "turn-finished", "total": 0, "failed": 0, "errored": True})

    def test_a_node_that_is_not_there_never_raises(self):
        h = FleetHarness(fail=True)
        h.reporter.begin("s1", "t1", ROOM, READER)
        h.reporter.tool_started("s1", "t1", "c1", "todo", {})
        h.reporter.end("s1", "t1")
        h.reporter.sent(ROOM, "$answer")


class FleetPhaseTest(unittest.TestCase):
    """The card's track: Thinking (turn-started), Tools (step), Writing (writing), Done."""

    def test_answer_text_reports_writing_once_and_carries_none_of_it(self):
        h = FleetHarness()
        r = h.reporter
        r.begin("s1", "t1", ROOM, READER)
        r.answer_began("s1", "t1")
        r.answer_began("s1", "t1")
        self.assertEqual(h.events(), [{"type": "turn-started"}, {"type": "writing"}])

    def test_writing_again_after_a_tool(self):
        h = FleetHarness()
        r = h.reporter
        r.begin("s1", "t1", ROOM, READER)
        r.answer_began("s1", "t1")
        r.tool_started("s1", "t1", "c1", "todo", {})
        r.tool_finished("s1", "t1", "c1", "todo", {}, False)
        r.answer_began("s1", "t1")
        r.end("s1", "t1")
        self.assertEqual([e["type"] for e in h.events()],
                         ["turn-started", "writing", "step", "step", "writing", "turn-finished"])

    def test_text_while_a_tool_runs_is_not_writing(self):
        # Stream deltas come on Hermes's stream threads, so a preamble's last
        # words can land after the tool call they preceded. The tool is still
        # the phase until it finishes.
        h = FleetHarness()
        r = h.reporter
        r.begin("s1", "t1", ROOM, READER)
        r.tool_started("s1", "t1", "c1", "todo", {})
        r.answer_began("s1", "t1")
        self.assertEqual([e["type"] for e in h.events()], ["turn-started", "step"])

    def test_outside_a_reported_turn_nothing_is_said(self):
        h = FleetHarness()
        h.reporter.answer_began("s1", "t1")
        h.reporter.begin("s2", "t2", ROOM, READER)
        h.reporter.answer_began("s2", "other-turn")
        self.assertEqual(h.events(), [{"type": "turn-started"}])


class WritingGateTest(unittest.TestCase):
    def test_one_note_per_move_into_writing_not_one_per_delta(self):
        gate = live._WritingGate()
        self.assertTrue(gate.first("s1"))
        self.assertFalse(gate.first("s1"))
        self.assertTrue(gate.first("s2"))
        gate.reset("s1")
        self.assertTrue(gate.first("s1"))


class FleetAnswerTest(unittest.TestCase):
    def finished_with_tools(self, h):
        h.reporter.begin("s1", "t1", ROOM, READER)
        h.reporter.tool_started("s1", "t1", "c1", "todo", {})
        h.reporter.tool_finished("s1", "t1", "c1", "todo", {}, False)
        h.reporter.sent(ROOM, "$interim")  # sent during the turn: not its answer
        h.reporter.end("s1", "t1")

    def test_the_first_message_sent_after_the_turn_is_its_answer(self):
        h = FleetHarness()
        self.finished_with_tools(h)
        h.reporter.sent("!elsewhere:id.agentpod.dev", "$other-room")
        h.reporter.sent(ROOM, "$answer")
        h.reporter.sent(ROOM, "$later")
        answers = [e for e in h.events() if e["type"] == "answer"]
        self.assertEqual(answers, [{"type": "answer", "eventId": "$answer", "total": 1, "failed": 0}])

    def test_a_turn_without_tools_has_no_answer_to_report(self):
        h = FleetHarness()
        h.reporter.begin("s1", "t1", ROOM, READER)
        h.reporter.end("s1", "t1")
        h.reporter.sent(ROOM, "$answer")
        self.assertNotIn("answer", [e["type"] for e in h.events()])

    def test_an_answer_long_after_the_turn_is_not_matched_to_it(self):
        h = FleetHarness()
        self.finished_with_tools(h)
        h.clock.now += live.ANSWER_WAIT_S + 1
        h.reporter.sent(ROOM, "$much-later")
        self.assertNotIn("answer", [e["type"] for e in h.events()])


class FleetDecisionTest(unittest.TestCase):
    def test_an_approval_is_reported_with_its_prompts_event_then_cleared(self):
        h = FleetHarness()
        h.reporter.begin("s1", "t1", ROOM, READER)
        h.reporter.approval_asked("s1", "t1", "Run rm -rf build?")
        self.assertEqual(h.events()[-1]["type"], "turn-started")  # nothing until the prompt is in the room
        h.reporter.sent(ROOM, "$prompt")
        self.assertEqual(h.events()[-1], {"type": "decision-asked", "eventId": "$prompt",
                                          "question": "Run rm -rf build?"})
        h.reporter.approval_answered("s1", "t1")
        self.assertEqual(h.events()[-1], {"type": "decision-cleared"})

    def test_a_question_is_bounded_like_the_card(self):
        h = FleetHarness()
        h.reporter.begin("s1", "t1", ROOM, READER)
        h.reporter.approval_asked("s1", "t1", "q" * 500)
        h.reporter.sent(ROOM, "$prompt")
        self.assertLessEqual(len(h.events()[-1]["question"]), live.FLEET_QUESTION_MAX)

    def test_a_turn_that_ends_with_a_question_open_clears_it(self):
        h = FleetHarness()
        h.reporter.begin("s1", "t1", ROOM, READER)
        h.reporter.approval_asked("s1", "t1", "Push?")
        h.reporter.sent(ROOM, "$prompt")
        h.reporter.end("s1", "t1")
        self.assertEqual([e["type"] for e in h.events()][-2:], ["decision-cleared", "turn-finished"])

    def test_an_approval_outside_a_reported_turn_is_ignored(self):
        h = FleetHarness()
        h.reporter.approval_asked("nope", "t1", "Push?")
        h.reporter.sent(ROOM, "$prompt")
        h.reporter.approval_answered("nope", "t1")
        self.assertEqual(h.reports, [])


class SentEventTapTest(unittest.TestCase):
    def record(self, msg, args, name="plugins.platforms.matrix.adapter"):
        return logging.LogRecord(name, logging.INFO, __file__, 1, msg, args, None)

    def test_hermes_matrix_send_log_lines_become_sent_events(self):
        seen = []
        tap = live._SentEventTap(lambda room, event: seen.append((room, event)))
        tap.emit(self.record("Matrix: sent event %s to %s", ("$a", ROOM)))
        tap.emit(self.record("Matrix: sent event %s to %s (after key share)", ("$b", ROOM)))
        tap.emit(self.record("Matrix: sent event %s", ("$c",)))
        tap.emit(self.record("Matrix: sent event %s as a reaction in %s", ("$r", ROOM)))
        tap.emit(self.record("something else %s to %s", ("$d", ROOM)))
        tap.emit(self.record(None, None))
        self.assertEqual(seen, [(ROOM, "$a"), (ROOM, "$b")])

    def test_a_failing_callback_never_reaches_hermes_logging(self):
        def boom(*_):
            raise RuntimeError("x")
        live._SentEventTap(boom).emit(self.record("Matrix: sent event %s to %s", ("$a", ROOM)))


class _NodeSocket:
    """A stand-in for the node's fleet socket: records each line, answers one."""

    def __init__(self, answer="ok"):
        self.dir = tempfile.mkdtemp(prefix="fl", dir="/tmp")
        self.path = os.path.join(self.dir, "fleet.sock")
        self.lines = []
        self.answer = answer
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(self.path)
        self.sock.listen(16)
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            with conn:
                data = b""
                while not data.endswith(b"\n"):
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    data += chunk
                self.lines.append(json.loads(data))
                conn.sendall((self.answer + "\n").encode())

    def close(self):
        self.sock.close()
        shutil.rmtree(self.dir, ignore_errors=True)


class FleetSocketTest(unittest.TestCase):
    def test_one_json_line_per_report(self):
        node = _NodeSocket()
        try:
            live.fleet_socket_sender(node.path)({"agent": AGENT, "event": {"type": "turn-started"}})
            self.assertEqual(node.lines, [{"agent": AGENT, "event": {"type": "turn-started"}}])
        finally:
            node.close()

    def test_a_refusal_is_an_error_the_reporter_counts(self):
        node = _NodeSocket(answer="error: a report needs roomId")
        try:
            with self.assertRaises(RuntimeError):
                live.fleet_socket_sender(node.path)({"agent": AGENT})
        finally:
            node.close()

    def test_no_node_fails_at_once(self):
        started = time.monotonic()
        with self.assertRaises(OSError):
            live.fleet_socket_sender("/tmp/agentpod-no-such-node.sock")({"agent": AGENT})
        self.assertLess(time.monotonic() - started, 0.2)

    def test_default_path_is_the_nodes(self):
        with mock.patch.dict(live.os.environ, {"HOME": "/root"}, clear=True):
            self.assertEqual(live.fleet_socket_path(), "/root/.agentpod/fleet.sock")
        with mock.patch.dict(live.os.environ, {"AGENTPOD_FLEET_SOCKET": "/run/f.sock"}, clear=True):
            self.assertEqual(live.fleet_socket_path(), "/run/f.sock")


if __name__ == "__main__":
    unittest.main()
