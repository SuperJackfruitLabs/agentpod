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

A third stands in for the node's fleet socket and records each fleet report,
and the test pins the two things the fleet reports lean on that no hook
covers: the Matrix adapter's "sent event" log line (the answer's event id)
and the approval hooks' session and turn ids.

Exit status 0 means the contract holds; anything else prints what broke.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import socket
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
    # None: the streaming turn. A dict: call exactly this tool with these args.
    forced: dict | None = None

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
            if ModelHandler.forced is not None:
                name, args = ModelHandler.forced["name"], ModelHandler.forced["args"]
            else:
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
                "agent": self.headers.get("User-Agent") or "",
                "messages": body.get("messages"),
            })
        data = b"{}"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


# ─── Fake node: records fleet reports ────────────────────────────────────────


class FleetNode:
    def __init__(self):
        # Short: a Unix socket path must fit sun_path (104 bytes on macOS).
        self.dir = tempfile.mkdtemp(prefix="apf", dir="/tmp")
        self.path = os.path.join(self.dir, "fleet.sock")
        self.reports: list = []
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
                try:
                    self.reports.append(json.loads(data))
                except ValueError:
                    self.reports.append({"unparsed": data.decode("utf-8", "replace")})
                conn.sendall(b"ok\n")

    def close(self):
        self.sock.close()
        shutil.rmtree(self.dir, ignore_errors=True)


def _serve(handler) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# ─── The turn ────────────────────────────────────────────────────────────────


def main() -> int:
    model = _serve(ModelHandler)
    matrix = _serve(MatrixHandler)
    node = FleetNode()

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
        "AGENTPOD_FLEET_SOCKET": node.path,
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
    _wait(lambda: any(r.get("event", {}).get("type") == "turn-finished" for r in node.reports), timeout=10)
    time.sleep(0.3)

    failures += _check(MatrixHandler.sent)
    failures += _check_fleet(node.reports)
    failures += _check_what_no_hook_covers()
    print(f"fleet reports: {[r.get('event', {}).get('type') for r in node.reports]}")
    node.close()
    failures += _check_bench(home, model, AIAgent)
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
        expect(not e["agent"].startswith("Python-urllib"),
               f"{e['type']} sent urllib's default User-Agent, which Cloudflare answers with 403")
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


def _check_fleet(reports: list) -> list[str]:
    """The turn, as the node's fleet socket saw it."""
    failures = []

    def expect(cond, message):
        if not cond:
            failures.append(message)

    expect(reports, "no fleet report reached the node's socket")
    for r in reports:
        expect(r.get("agent") == AGENT, f"fleet report not from the agent: {r}")
        expect(r.get("roomId") == ROOM, f"fleet report for the wrong room: {r}")
        expect(r.get("reader") == READER, f"fleet report for the wrong reader: {r}")
        expect(isinstance(r.get("at"), int) and abs(r["at"] / 1000 - time.time()) < 600, f"fleet report time: {r}")
    types = [r.get("event", {}).get("type") for r in reports]
    expect(types[:1] == ["turn-started"], f"the first fleet report is not turn-started: {types}")
    expect(types[-1:] == ["turn-finished"], f"the last fleet report is not turn-finished: {types}")
    steps = [r["event"] for r in reports if r.get("event", {}).get("type") == "step"]
    expect([(s.get("completed"), s.get("total")) for s in steps] == [(0, 1), (1, 1)],
           f"steps: {[(s.get('completed'), s.get('total')) for s in steps]}")
    if steps:
        title = str(steps[0].get("title", ""))
        expect(title.startswith(ModelHandler.tool) and len(title) <= 60,
               f"step title {title!r} is not Hermes's ACP title, bounded for the card")
    # The card's Writing phase: said once, when the answer began streaming
    # after the tool, from the text stream (not the reasoning), with no text.
    writing = [i for i, t in enumerate(types) if t == "writing"]
    last_step = max((i for i, t in enumerate(types) if t == "step"), default=-1)
    expect(len(writing) == 1 and writing[0] > last_step,
           f"the answer beginning is not one writing report after the steps: {types}")
    if writing:
        expect(reports[writing[0]].get("event") == {"type": "writing"},
               f"a writing report carries more than that: {reports[writing[0]].get('event')}")
    finished = reports[-1].get("event", {}) if reports else {}
    expect(finished == {"type": "turn-finished", "total": 1, "failed": 0}, f"turn-finished: {finished}")
    return failures


def _check_what_no_hook_covers() -> list[str]:
    """What the fleet reports read from Hermes outside its hook payloads."""
    import inspect

    import hermes_cli
    from hermes_cli.plugins import VALID_HOOKS

    failures = []
    for hook in ("pre_approval_request", "post_approval_response"):
        if hook not in VALID_HOOKS:
            failures.append(f"Hermes has no {hook} hook any more: approvals will not reach the fleet card")

    # The approval hooks must carry the turn they belong to, or an approval
    # cannot be placed in its room.
    try:
        from tools import approval_context
        source = inspect.getsource(approval_context._fire_approval_hook)
        for key in ("session_id", "turn_id"):
            if key not in source:
                failures.append(f"approval hooks no longer carry {key}: approvals will not reach the fleet card")
    except Exception as exc:
        failures.append(f"could not read Hermes's approval hook dispatch: {exc}")

    # The answer's event id is read off this log line; nothing else gives it.
    root = pathlib.Path(hermes_cli.__file__).resolve().parent.parent
    adapter = root / "plugins" / "platforms" / "matrix" / "adapter.py"
    try:
        text = adapter.read_text()
        needle = 'logger.info("Matrix: sent event %s to %s", last_event_id, chat_id)'
        if needle not in text:
            failures.append(f"{adapter} no longer logs {needle!r}: answer pushes lose their turn counts")
    except OSError as exc:
        failures.append(f"could not read Hermes's Matrix adapter: {exc}")
    return failures


# ─── Remote bench ────────────────────────────────────────────────────────────

BENCH_ID = "0123456789abcdef0123456789abcdef"
BENCH_DIR = "/srv/superbench-data/benches/contract"


def _bench_turn(model, AIAgent, session_id: str, tool: dict) -> tuple:
    """One turn whose model calls *tool*; returns (system prompt, tool result) as Hermes sent them."""
    ModelHandler.forced = tool
    first = len(ModelHandler.requests)
    agent = AIAgent(
        base_url=f"http://127.0.0.1:{model.server_port}/v1", api_key="contract-key", provider="custom", model=MODEL,
        quiet_mode=True, skip_context_files=True, skip_memory=True, enabled_toolsets=["file"], platform="cli",
        session_id=session_id,
    )
    try:
        agent.run_conversation("Edit the file.")
    finally:
        ModelHandler.forced = None
    turn = [r for r in ModelHandler.requests[first:] if r.get("stream")]
    system = next((m.get("content") for m in (turn[0].get("messages") if turn else []) if m.get("role") == "system"), "")
    results = [m.get("content") for r in turn for m in r.get("messages") or [] if m.get("role") == "tool"]
    if isinstance(system, list):
        system = " ".join(str(part.get("text", "")) for part in system if isinstance(part, dict))
    return str(system or ""), str(results[-1] if results else "")


def _check_bench(home: pathlib.Path, model, AIAgent) -> list[str]:
    """Attached, a replace-mode patch is rewritten into V4A and lands with the same result, and
    the model is told where it is working. Detached, neither happens."""
    failures = []

    def expect(cond, message):
        if not cond:
            failures.append(message)

    # On a remote backend replace mode cannot get past edit approval; here, on a local one, it
    # would quietly work. So the replace path is made to fail, as it does remotely, and which
    # path ran is recorded: the edit may land only through V4A.
    from tools import file_operations as fo

    used: list[str] = []
    real_v4a = fo.ShellFileOperations.patch_v4a

    def replace_refused(self, *_a, **_k):
        used.append("replace")
        raise RuntimeError("replace mode reached the backend (as on a remote bench, it cannot land)")

    def v4a_seen(self, *a, **k):
        used.append("v4a")
        return real_v4a(self, *a, **k)

    fo.ShellFileOperations.patch_replace, real_replace = replace_refused, fo.ShellFileOperations.patch_replace
    fo.ShellFileOperations.patch_v4a = v4a_seen
    try:
        failures += _bench_scenarios(home, model, AIAgent, used)
    finally:
        fo.ShellFileOperations.patch_replace, fo.ShellFileOperations.patch_v4a = real_replace, real_v4a
    return failures


def _bench_scenarios(home: pathlib.Path, model, AIAgent, used: list) -> list[str]:
    failures = []

    def expect(cond, message):
        if not cond:
            failures.append(message)

    state = home / "agentpod-bench.json"
    state.write_text(json.dumps({"version": 1, "bench_id": BENCH_ID, "working_directory": BENCH_DIR,
                                 "valid_before": "2099-01-01T00:00:00Z"}))
    target = home / "bench-edit.py"
    original = "def f():\n    return 'alpha beta gamma'\n\n\ndef g():\n    return 2\n"
    target.write_text(original)
    replace = {"path": str(target), "old_string": "beta", "new_string": "BETA"}
    system, result = _bench_turn(model, AIAgent, "contract-bench", {"name": "patch", "args": replace})
    expect(target.read_text() == original.replace("beta", "BETA"),
           f"attached: replace-mode patch did not land as V4A with the same result: {target.read_text()!r} ({result[:300]})")
    expect(BENCH_ID in system and BENCH_DIR in system, "attached: the bench note is not in the session's system prompt")
    expect(used == ["v4a"], f"attached: the edit went through {used}, not V4A alone")

    # Multi-line, whole-line edit, as a model often sends it.
    replace = {"path": str(target), "old_string": "def g():\n    return 2\n", "new_string": "def g():\n    return 3\n"}
    _, result = _bench_turn(model, AIAgent, "contract-bench-2", {"name": "patch", "args": replace})
    expect(target.read_text().endswith("def g():\n    return 3\n"), f"attached: multi-line replace did not land: {result[:300]}")
    expect(used == ["v4a", "v4a"], f"attached: the multi-line edit went through {used}")

    replace_all = {"path": str(target), "old_string": "return", "new_string": "yield", "replace_all": True}
    before = target.read_text()
    _, result = _bench_turn(model, AIAgent, "contract-bench-3", {"name": "patch", "args": replace_all})
    expect(target.read_text() == before and ("mode=\\\"patch\\\"" in result or 'mode="patch"' in result),
           f"attached: replace_all was not blocked with a V4A hint: {result[:300]}")

    expect(used == ["v4a", "v4a"], f"attached: a blocked replace_all still reached the backend: {used}")

    state.unlink()
    replace = {"path": str(target), "old_string": "BETA", "new_string": "beta"}
    _bench_turn(model, AIAgent, "contract-detached-edit", {"name": "patch", "args": replace})
    expect(used[-1:] == ["replace"], f"detached: the hook still rewrote a replace-mode patch: {used}")
    system, _ = _bench_turn(model, AIAgent, "contract-detached", {"name": "read_file", "args": {"path": str(target)}})
    expect(BENCH_ID not in system, "detached: the bench note is still in the system prompt")
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
