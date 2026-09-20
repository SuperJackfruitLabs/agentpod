"""Fresh-session ACP skill discovery only; never sends prompts or client tools.

The caller provides an installed adapter and a disposable home. No authentication
or user configuration is inherited. The provider points to a closed loopback port.
"""
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import threading
import time


def scan(adapter, workspace, home):
    home = Path(home)
    home.mkdir(exist_ok=True)
    (home / 'config.toml').write_text(
        'model_provider = "synthetic"\nmodel = "gpt-5.4"\n'
        '[model_providers.synthetic]\nname = "Synthetic offline discovery"\n'
        'base_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n'
        'requires_openai_auth = false\n')
    env = {'PATH': os.environ['PATH'], 'HOME': str(home),
           'CODEX_HOME': str(home), 'NO_BROWSER': '1'}
    events = queue.Queue(maxsize=1024)
    stopped = threading.Event()
    process = subprocess.Popen([str(adapter)], cwd=workspace, env=env,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True,
                               start_new_session=True)

    def read():
        try:
            while not stopped.is_set():
                line = process.stdout.readline(1024 * 1024 + 1)
                if not line:
                    value = RuntimeError('ACP output closed before discovery completed')
                elif len(line) > 1024 * 1024:
                    value = RuntimeError('ACP frame exceeds probe limit')
                else:
                    try:
                        value = json.loads(line)
                    except ValueError:
                        value = RuntimeError('ACP returned invalid JSON')
                while not stopped.is_set():
                    try:
                        events.put(value, timeout=.1)
                        break
                    except queue.Full:
                        pass
                if isinstance(value, Exception):
                    return
        except (OSError, ValueError):
            return

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    deadline = time.monotonic() + 45
    commands = None

    def receive():
        nonlocal commands
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('ACP discovery deadline exceeded')
        try:
            event = events.get(timeout=remaining)
        except queue.Empty:
            raise TimeoutError('ACP discovery deadline exceeded') from None
        if isinstance(event, Exception):
            raise event
        if 'method' in event and 'id' in event:
            raise RuntimeError('ACP requested an unsupported client action')
        update = event.get('params', {}).get('update', {})
        if update.get('sessionUpdate') == 'available_commands_update':
            commands = update['availableCommands']
        return event

    try:
        for number, method, params in (
            (1, 'initialize', {'protocolVersion': 1, 'clientCapabilities': {},
                               'clientInfo': {'name': 'agentpod-synthetic-discovery', 'version': '1'}}),
            (2, 'session/new', {'cwd': str(workspace), 'mcpServers': []}),
        ):
            process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': number,
                                            'method': method, 'params': params}) + '\n')
            process.stdin.flush()
            while True:
                event = receive()
                if event.get('id') == number:
                    if 'error' in event or 'result' not in event:
                        raise RuntimeError('ACP request failed: ' + method)
                    break
        while commands is None:
            receive()
        return [{'name': command['name'][1:], 'description': command.get('description', '')}
                for command in commands if command['name'].startswith('$')]
    finally:
        stopped.set()
        # The adapter owns a Codex child. Signal the group even if the adapter
        # has already exited, then reap the direct child and drain its reader.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        reader.join(timeout=5)
        if reader.is_alive():
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            reader.join(timeout=5)
        process.stdin.close()
        process.stdout.close()
