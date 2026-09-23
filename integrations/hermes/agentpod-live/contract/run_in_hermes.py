"""Contract test: the plugin, loaded by a real Hermes, streams a real turn.

Run with the Python of a Hermes checkout (`pip install -e 'hermes-agent[acp]'`):

    python contract/run_in_hermes.py

The unit tests pin the plugin's own policy. This pins the part the plugin does
not own: Hermes's plugin discovery, hook names and payloads, stream-hook
dispatch, session context and the ACP tool-title helper. Everything a Hermes
upgrade could break without the plugin changing.

Nothing is faked on the Hermes side. A local server stands in for the model,
streaming reasoning, a tool call and an answer; another stands in for the
Matrix homeserver and records every `sendToDevice`. The turn runs through
`AIAgent.run_conversation`, the same entry point the gateway uses.

Exit status 0 means the contract holds; anything else prints what broke.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PLUGIN_DIR = pathlib.Path(__file__).resolve().parent.parent
ROOM = "!contract:hs.test"
READER = "@reader:hs.test"
AGENT = "@agent_contract:hs.test"
MODEL = "contract/model"

REASONING = "The user wants a plan. I should record it as a todo first."
ANSWER_PARTS = ["Here is the plan. ", "First, we write the tests. ", "Then, we ship it to one agent."]


# ─── Fake model: an OpenAI-compatible chat endpoint ──────────────────────────


def _chunk(delta: dict, finish: str | None = None) -> bytes:
    body = {
        "id": "chatcmpl-contract",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": MODEL,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return f"data: {json.dumps(body)}\n\n".encode()


class ModelHandler(BaseHTTPRequestHandler):
    requests: list = []
    tool: str = ""

    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._json({"object": "list", "data": [{"id": MODEL, "object": "model"}]})
        else:
            self._json({}, status=404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        ModelHandler.requests.append(body)
        messages = body.get("messages") or []
        after_tool = any(m.get("role") == "tool" for m in messages)

        if not body.get("stream"):
            # Auxiliary calls (titles, summaries) are not part of the turn.
            self._json({
                "id": "chatcmpl-aux", "object": "chat.completion", "created": int(time.time()), "model": MODEL,
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": "ok"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            })
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not after_tool:
            for word in REASONING.split(" "):
                self._send(_chunk({"role": "assistant", "reasoning_content": word + " "}))
            name, args = _pick_tool(body.get("tools") or [])
            ModelHandler.tool = name
            self._send(_chunk({"tool_calls": [{
                "index": 0, "id": "call_contract_1", "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }]}))
            self._send(_chunk({}, finish="tool_calls"))
        else:
            for part in ANSWER_PARTS:
                self._send(_chunk({"role": "assistant", "content": part}))
                time.sleep(0.05)
            self._send(_chunk({}, finish="stop"))
        self._send(b"data: [DONE]\n\n")

    def _send(self, data: bytes):
        self.wfile.write(data)
        self.wfile.flush()

    def _json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


NOTE_PATH = ""  # set in main(): a real file for read_file to open


def _pick_tool(tools: list) -> tuple:
    """The tool to call, chosen from what Hermes offered rather than by name.

    Hermes renames tools (`todo` became `todo_list`); a hard-coded name would
    make this test fail on a rename that does not affect the plugin at all.
    `read_file` is preferred because it exercises kind and locations.
    """
    names = [t.get("function", {}).get("name") for t in tools if t.get("function")]
    if "read_file" in names:
        return "read_file", {"path": NOTE_PATH}
    if not names:
        raise RuntimeError("Hermes offered the model no tools")
    return names[0], {}


# ─── Fake homeserver: records sendToDevice ───────────────────────────────────


class MatrixHandler(BaseHTTPRequestHandler):
    sent: list = []

    def log_message(self, *_):
        pass

    def do_PUT(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        parts = self.path.split("/")
        if "sendToDevice" in parts:
            event_type = parts[parts.index("sendToDevice") + 1]
            MatrixHandler.sent.append({
                "type": event_type,
                "auth": self.headers.get("Authorization"),
                "messages": body.get("messages"),
            })
        data = b"{}"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _serve(handler) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# ─── The turn ────────────────────────────────────────────────────────────────


def main() -> int:
    model = _serve(ModelHandler)
    matrix = _serve(MatrixHandler)

    home = pathlib.Path(tempfile.mkdtemp(prefix="agentpod-live-contract-"))
    shutil.copytree(PLUGIN_DIR, home / "plugins" / "agentpod-live",
                    ignore=shutil.ignore_patterns("contract", "test_*", "__pycache__", "*.md"))
    (home / "config.yaml").write_text(
        "plugins:\n"
        "  enabled: [agentpod-live]\n"
        "  stream_reasoning_deltas: true\n"
    )

    global NOTE_PATH
    note = home / "note.md"
    note.write_text("the plan\n")
    NOTE_PATH = str(note)

    # Before any Hermes import: its home and the plugin's credentials are read
    # from the environment.
    os.environ.update({
        "HERMES_HOME": str(home),
        "MATRIX_HOMESERVER": f"http://127.0.0.1:{matrix.server_port}",
        "MATRIX_ACCESS_TOKEN": "contract-token",
        "MATRIX_USER_ID": AGENT,
        "OPENAI_API_KEY": "contract-key",
    })

    from hermes_cli.plugins import discover_plugins, get_plugin_manager
    from gateway.session_context import clear_session_vars, set_session_vars
    from run_agent import AIAgent

    discover_plugins(force=True)
    manager = get_plugin_manager()
    loaded = _loaded_plugins(manager)
    failures: list[str] = []
    if "agentpod-live" not in loaded:
        failures.append(f"Hermes did not load the plugin (loaded: {sorted(loaded)})")
        return _report(failures, home)

    agent = AIAgent(
        base_url=f"http://127.0.0.1:{model.server_port}/v1",
        api_key="contract-key",
        provider="custom",
        model=MODEL,
        quiet_mode=True,
        skip_context_files=True,
        skip_memory=True,
        enabled_toolsets=["file"],
        platform="matrix",
        user_id=READER,
        session_id="contract-session",
    )

    tokens = set_session_vars(platform="matrix", chat_id=ROOM, user_id=READER, session_id="contract-session")
    try:
        agent.run_conversation("Make a plan and tell me.")
    finally:
        clear_session_vars(tokens)

    # Hooks are asynchronous by design; give the plugin's sender a moment.
    _wait(lambda: _done_seen(MatrixHandler.sent), timeout=10)
    time.sleep(0.3)

    failures += _check(MatrixHandler.sent)
    return _report(failures, home)


def _loaded_plugins(manager) -> set:
    names = set()
    for attr in ("_plugins", "plugins", "loaded"):
        value = getattr(manager, attr, None)
        if isinstance(value, dict):
            for key, plugin in value.items():
                if getattr(plugin, "enabled", True) and not getattr(plugin, "error", None):
                    names.add(key)
    return names


def _done_seen(sent) -> bool:
    return any(e["type"] == "dev.agentpod.stream.delta" and _content(e).get("done") for e in sent)


def _content(event) -> dict:
    return (event.get("messages") or {}).get(READER, {}).get("*", {})


def _wait(predicate, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and not predicate():
        time.sleep(0.05)


# ─── The contract ────────────────────────────────────────────────────────────


def _check(sent: list) -> list[str]:
    failures = []

    def expect(cond, message):
        if not cond:
            failures.append(message)

    expect(sent, "no sendToDevice reached the homeserver")
    for e in sent:
        expect(e["auth"] == "Bearer contract-token", f"{e['type']} was not sent with the agent's token")
        expect(list((e.get("messages") or {}).keys()) == [READER], f"{e['type']} was not addressed to the reader")
        expect(list((e.get("messages") or {}).get(READER, {}).keys()) == ["*"], f"{e['type']} did not target all devices")

    by_type: dict[str, list[dict]] = {}
    for e in sent:
        by_type.setdefault(e["type"], []).append(_content(e))

    answers = by_type.get("dev.agentpod.stream.delta", [])
    thoughts = by_type.get("dev.agentpod.thought.delta", [])
    tools = by_type.get("dev.agentpod.tool.update", [])

    # The answer: cumulative, ordered, finished.
    expect(len(answers) >= 2, f"expected the answer to stream in more than one delta, got {len(answers)}")
    if answers:
        seqs = [a.get("seq") for a in answers]
        expect(seqs == sorted(seqs) and len(set(seqs)) == len(seqs), f"answer seq not strictly increasing: {seqs}")
        expect(answers[-1].get("done") is True, "the last answer delta is not done")
        expect(all(not a.get("done") for a in answers[:-1]), "a non-final answer delta says done")
        final = answers[-1].get("text", "")
        expect("".join(ANSWER_PARTS).strip() in final, f"final answer text is incomplete: {final!r}")
        texts = [a.get("text", "") for a in answers]
        expect(all(texts[i + 1].startswith(texts[i]) for i in range(len(texts) - 1)),
               "answer text is not cumulative")
        ids = {a.get("session_id") for a in answers}
        expect(len(ids) == 1 and "" not in ids and None not in ids, f"answer session_id unstable or empty: {ids}")
        expect(all(a.get("room_id") == ROOM for a in answers), "answer delta has the wrong room")
        expect("record it as" not in final, "reasoning leaked into the answer")

    # Reasoning: its own channel, finished.
    expect(ModelHandler.tool, "the model was never asked to call a tool")
    expect(thoughts, "no reasoning reached the thought channel (stream_reasoning_deltas / kind)")
    if thoughts:
        expect(thoughts[-1].get("done") is True, "the last thought delta is not done")
        expect("record it as a todo" in thoughts[-1].get("text", ""), "thought text is incomplete")

    # The tool call: started, then finished, with Hermes's own title and kind.
    expect(len(tools) >= 2, f"expected two tool updates, got {len(tools)}")
    if len(tools) >= 2:
        expect([t.get("status") for t in tools[:2]] == ["in_progress", "completed"],
               f"tool statuses: {[t.get('status') for t in tools]}")
        expect(len({t.get("tool_call_id") for t in tools}) == 1, "tool updates do not share one tool_call_id")
        title = str(tools[0].get("title", ""))
        expect(title.startswith(ModelHandler.tool) and title != ModelHandler.tool,
               f"tool title {title!r} is not Hermes's ACP title (acp_adapter.tools.build_tool_title moved?)")
        expect(isinstance(tools[0].get("locations"), list), "tool locations is not a list")
        if ModelHandler.tool == "read_file":
            expect(tools[0].get("kind") == "read", f"tool kind: {tools[0].get('kind')!r} (ACP kind map moved?)")
            expect(tools[0].get("locations") == [NOTE_PATH], f"tool locations: {tools[0].get('locations')!r}")

    # One turn, one id, across every channel.
    all_ids = {c.get("session_id") for c in answers + thoughts + tools}
    expect(len(all_ids) == 1, f"channels disagree on the turn id: {all_ids}")
    return failures


def _report(failures: list[str], home: pathlib.Path) -> int:
    shutil.rmtree(home, ignore_errors=True)
    kinds = {}
    for e in MatrixHandler.sent:
        kinds[e["type"]] = kinds.get(e["type"], 0) + 1
    print(f"model requests: {len(ModelHandler.requests)}; to-device events: {kinds}")
    if failures:
        print("CONTRACT BROKEN:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("contract holds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
