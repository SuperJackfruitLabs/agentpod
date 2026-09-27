import os
from pathlib import Path
import sys
import tempfile
import unittest

from probe_codex_acp import scan


class ACPProbeTests(unittest.TestCase):
    def test_synthetic_adapter_sees_isolated_environment_and_only_discovery_requests(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            adapter = root / 'adapter'
            adapter.write_text('#!' + sys.executable + '\n' + '''
import json, os, sys
assert 'CODEX_PATH' not in os.environ
assert 'OPENAI_API_KEY' not in os.environ
assert os.environ['HOME'] == os.environ['CODEX_HOME']
for line in sys.stdin:
 r=json.loads(line)
 assert r['method'] in ('initialize', 'session/new')
 if r['method']=='session/new':
  assert r['params']['mcpServers']==[]
  print(json.dumps({'method':'session/update','params':{'update':{'sessionUpdate':'available_commands_update','availableCommands':[{'name':'$sjl-fixture:sjl-fixture','description':'synthetic'}, {'name':'plan','description':'builtin'}]}}}),flush=True)
 print(json.dumps({'id':r['id'],'result':{}}),flush=True)
''')
            adapter.chmod(0o755)
            old = os.environ.get('OPENAI_API_KEY')
            os.environ['OPENAI_API_KEY'] = 'synthetic-must-not-be-inherited'
            try:
                self.assertEqual(scan(adapter, root, root / 'home'), [{'name': 'sjl-fixture:sjl-fixture', 'description': 'synthetic'}])
            finally:
                if old is None:
                    os.environ.pop('OPENAI_API_KEY', None)
                else:
                    os.environ['OPENAI_API_KEY'] = old

    def test_failed_session_is_not_reported_as_empty_discovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            adapter = root / 'adapter'
            adapter.write_text('#!' + sys.executable + '\nimport json,sys\nfor line in sys.stdin:\n r=json.loads(line); print(json.dumps({"id":r["id"],"error":{"code":-32000}}),flush=True)\n')
            adapter.chmod(0o755)
            with self.assertRaisesRegex(RuntimeError, 'ACP request failed'):
                scan(adapter, root, root / 'home')


if __name__ == '__main__':
    unittest.main()
