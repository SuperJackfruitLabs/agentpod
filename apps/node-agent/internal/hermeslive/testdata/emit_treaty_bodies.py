"""Drive the embedded agentpod-live plugin's LiveEmitter and print every body it sends.

Run by plugin_treaty_test.go as `python3 -I -B emit_treaty_bodies.py <path to __init__.py>`. One
JSON object per line: {"type": <event type>, "reader": <mxid>, "content": <body>}. Stdlib only, and
no Hermes: `_describe_tool` falls back to its plain row, which is one of the shapes it sends.
"""

import importlib.util
import json
import sys
import types

spec = importlib.util.spec_from_file_location("agentpod_live", sys.argv[1])
live = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = live
spec.loader.exec_module(live)


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


# Hermes's ACP adapter, as far as `_describe_tool` reads it, so the row with a kind is sent too.
adapter = types.ModuleType("acp_adapter")
tools = types.ModuleType("acp_adapter.tools")
tools.build_tool_title = lambda name, args: f"{name}: {args.get('path', '')}"
tools.extract_locations = lambda args: [types.SimpleNamespace(path=args["path"])] if "path" in args else []
tools.get_tool_kind = lambda name: "read" if name == "read_file" else "execute"
adapter.tools = tools
WITH_ADAPTER = {"acp_adapter": adapter, "acp_adapter.tools": tools}

clock = Clock()
sent = []
emitter = live.LiveEmitter(lambda t, reader, content: sent.append({"type": t, "reader": reader, "content": content}),
                           clock=clock, own_user="@agent:id.agentpod.dev")
ROOM, READER = "!room:id.agentpod.dev", "@reader:id.agentpod.dev"

# A turn with its own id: the wire session_id is the turn id.
emitter.begin("ses_1", "turn_1", ROOM, READER)
emitter.delta("ses_1", "turn_1", "Thinking about the request first.", "reasoning")
emitter.delta("ses_1", "turn_1", "Here is the first sentence of the answer.", "text")
clock.now += 2
emitter.delta("ses_1", "turn_1", " And more", "text")
# A tool with an id, one without (the plugin makes up a tc- id), one that fails.
emitter.tool_started("ses_1", "turn_1", "call_1", "read_file", {"path": "/src/app.py"})
emitter.tool_finished("ses_1", "turn_1", "call_1", "read_file", {"path": "/src/app.py"}, False)
emitter.tool_started("ses_1", "turn_1", "", "terminal", {"command": "pytest"})
emitter.tool_finished("ses_1", "turn_1", "", "terminal", {"command": "pytest"}, True)
emitter.tool_finished("ses_1", "turn_1", "", "web_search", "not a dict", False)
emitter.end("ses_1", "turn_1")

# The same calls with Hermes's adapter present: rows with a kind.
sys.modules.update(WITH_ADAPTER)
emitter.begin("ses_3", "turn_3", ROOM, READER)
emitter.tool_started("ses_3", "turn_3", "call_9", "read_file", {"path": "/README.md"})
emitter.tool_finished("ses_3", "turn_3", "call_9", "read_file", {"path": "/README.md"}, False)
emitter.tool_started("ses_3", "turn_3", "", "terminal", {"command": "ls"})
emitter.end("ses_3", "turn_3")
for name in WITH_ADAPTER:
    del sys.modules[name]

# A turn with no turn id: the wire session_id falls back to the session id.
emitter.begin("ses_2", "", ROOM, READER)
emitter.delta("ses_2", "", "A short one.", "text")
clock.now += 2
emitter.delta("ses_2", "", " Done.", "text")
emitter.end("ses_2", "")

for body in sent:
    print(json.dumps(body))
