"""Tests for the agentpod-live Hermes plugin. Stdlib only: `python3 -m unittest`."""

import importlib.util
import json
import pathlib
import sys
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
               "HERMES_SESSION_CHAT_ID": ROOM, "HERMES_SESSION_USER_ID": READER}
        with mock.patch.dict(live.os.environ, env, clear=True), \
                mock.patch.object(live, "matrix_sender", return_value=lambda t, r, c: sent.append((t, r, c))):
            live.register(ctx)
            self.assertEqual(set(ctx.hooks), {"pre_llm_call", "post_llm_call", "on_stream_delta",
                                              "pre_tool_call", "post_tool_call"})
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


if __name__ == "__main__":
    unittest.main()
