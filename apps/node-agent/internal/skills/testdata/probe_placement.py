#!/usr/bin/env python3
"""Probe Go native publication in disposable Git workspaces, without model turns.

Build the test binary with `go test -c -o /absolute/tests ./internal/skills`.
Native commands use explicit binaries; Pi exercises its installed loader only.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time

ROOTS={'codex':'.agents/skills','opencode':'.opencode/skills','pi':'.pi/skills','openclaw':'skills'}

class Codex:
    def __init__(self,binary,root):
        self.events=queue.Queue(maxsize=1024);self.seq=0;self.stopped=threading.Event()
        self.log=(root/'codex.stderr').open('w')
        self.p=subprocess.Popen([binary,'app-server','--stdio'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,text=True)
        def read():
            for line in self.p.stdout:
                if len(line)>32*1024*1024: break
                try: value=json.loads(line)
                except ValueError: continue
                while not self.stopped.is_set():
                    try: self.events.put(value,timeout=.2);break
                    except queue.Full: pass
        self.reader=threading.Thread(target=read,daemon=True);self.reader.start()
        try:
            self.request('initialize',{'clientInfo':{'name':'agentpod_synthetic_placement_probe','version':'1'}})
            self.send({'method':'initialized','params':{}})
        except BaseException:
            self.close();raise
    def send(self,value):
        self.p.stdin.write(json.dumps(value)+'\n');self.p.stdin.flush()
    def request(self,method,params):
        self.seq+=1;self.send({'id':self.seq,'method':method,'params':params});deadline=time.monotonic()+40
        while True:
            event=self.events.get(timeout=max(.01,deadline-time.monotonic()))
            if event.get('id')==self.seq:
                if 'error' in event: raise RuntimeError('native API returned an error')
                return event['result']
            if time.monotonic()>deadline: raise TimeoutError('native API deadline')
    def close(self):
        self.stopped.set();self.p.terminate()
        try:self.p.wait(timeout=5)
        except subprocess.TimeoutExpired:self.p.kill();self.p.wait()
        self.reader.join(timeout=5)
        for stream in (self.p.stdin,self.p.stdout,self.log):stream.close()

def probe(args):
    binary=str(Path(shutil.which(args.binary) or args.binary).resolve())
    test_binary=str(Path(args.node_test_binary).resolve())
    version=subprocess.run([binary,'--version'],check=True,capture_output=True,text=True,timeout=45).stdout.strip()
    acp_adapter=getattr(args,'codex_acp_adapter',None)
    adapter_version=None
    if acp_adapter:
        if args.harness!='codex':raise ValueError('ACP comparison currently supports Codex only')
        acp_adapter=str(Path(shutil.which(acp_adapter) or acp_adapter).resolve())
        # Match the adapter's createRequire(import.meta.url) resolution, not PATH.
        resolved=subprocess.run(['node','--input-type=module','-e',
          "import {createRequire} from 'node:module'; console.log(createRequire(process.argv[1]).resolve('@openai/codex/bin/codex.js'));",acp_adapter],check=True,capture_output=True,text=True,timeout=10).stdout.strip()
        if Path(resolved).resolve()!=Path(binary):raise ValueError("--binary must be this adapter bundled Codex entrypoint")
        adapter_version=subprocess.run([acp_adapter,'--version'],check=True,capture_output=True,text=True,timeout=10).stdout.strip()
        if adapter_version!='@agentclientprotocol/codex-acp 1.1.14':raise ValueError('ACP probe needs review for this adapter version')
    checks=[];expected='sjl-fixture:sjl-fixture' if args.harness=='codex' else 'sjl-fixture'
    skills_dir=Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix='agentpod-native-placement-') as temporary:
        root=Path(temporary).resolve();workspace=root/'workspace';sibling=root/'sibling'
        for p in (workspace,sibling):
            p.mkdir();subprocess.run(['git','init','-q',str(p)],check=True)
        (workspace/'.sjl-native-fixture').write_text('synthetic native placement fixture\n')
        env=dict(os.environ)
        if args.harness=='opencode':
            env.update({key:str(root/key) for key in ('XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME')})
            env['OPENCODE_CONFIG_CONTENT']=json.dumps({'autoupdate':False,'share':'disabled','plugin':[]})
        if args.harness=='openclaw':env.update(OPENCLAW_STATE_DIR=str(root/'state'),OPENCLAW_CONFIG_PATH=str(root/'config.json'))
        if args.harness=='pi':
            if not args.pi_skills_module:raise ValueError('Pi requires its explicit installed loader module')
            (root/'pi-scan.mjs').write_text("import {pathToFileURL} from 'node:url';const {loadSkillsFromDir}=await import(pathToFileURL(process.argv[2]).href);console.log(JSON.stringify(loadSkillsFromDir({dir:process.argv[3],source:'agentpod-synthetic-probe'})));\n")
        native=Codex(binary,root) if args.harness=='codex' and not acp_adapter else None
        def operation(action):
            command_env=dict(os.environ,SJL_NATIVE_PLACEMENT_WORKSPACE=str(workspace),SJL_NATIVE_PLACEMENT_HARNESS=args.harness,SJL_NATIVE_PLACEMENT_ACTION=action)
            r=subprocess.run([test_binary,'-test.run=^TestNativePlacementFixtureOperation$'],cwd=skills_dir,env=command_env,capture_output=True,text=True,timeout=45)
            if r.returncode:raise RuntimeError('Go placement fixture failed: '+r.stdout[-2000:]+r.stderr[-1000:])
            rows=[line.removeprefix('SJL_NATIVE_RESULT ') for line in r.stdout.splitlines() if line.startswith('SJL_NATIVE_RESULT ')]
            if len(rows)!=1:raise RuntimeError('missing Go fixture result')
            result=json.loads(rows[0])
            if result['verification']['loaded']['value'] is not None:raise RuntimeError('filesystem receipt falsely claimed loading')
            return result
        def scan(directory):
            if acp_adapter:
                from probe_codex_acp import scan as scan_acp
                data={'skills':scan_acp(acp_adapter,directory,root/'acp-home')}
            elif native:data=native.request('skills/list',{'cwds':[str(directory)],'forceReload':True})['data'][0]
            else:
                if args.harness=='openclaw':
                    (root/'config.json').write_text(json.dumps({'agents':{'defaults':{'workspace':str(directory)}},'plugins':{'enabled':False}}))
                    cmd=[binary,'skills','list','--json']
                elif args.harness=='pi':cmd=['node',str(root/'pi-scan.mjs'),str(Path(args.pi_skills_module).resolve()),str(directory/ROOTS['pi'])]
                else:cmd=[binary,'--pure','debug','skill']
                output=root/'scan.json'
                with output.open('wb') as stream:r=subprocess.run(cmd,cwd=directory,env=env,stdout=stream,stderr=subprocess.PIPE,timeout=45)
                if r.returncode or output.stat().st_size>32*1024*1024:raise RuntimeError('native scan failed or exceeded its bound')
                data=json.loads(output.read_text())
                if isinstance(data,list):data={'skills':data}
            return [{key:item[key] for key in ('name','description','scope','source','eligible','enabled') if key in item} for item in data['skills'] if item['name'] in ('sjl-fixture','sjl-fixture:sjl-fixture')]
        def check(name,description=None,count=1,directory=workspace):
            observed=scan(directory)
            checks.append({'check':name,'passed':len(observed)==count and all(i['name']==expected and (description is None or i['description']==description) for i in observed),'observation':observed})
        try:
            operation('install');check('stored-generation-not-discovered',count=0)
            operation('plan');check('native-plan-does-not-publish',count=0)
            initial=operation('activate');check('native-discovery-after-go-publication','Verify a synthetic bundle.')
            target=Path(initial['verification']['path']);references=list((target/'skills/sjl-fixture/references').glob('*.md'))
            checks.append({'check':'bundled-reference-present','passed':len(references)==1,'sha256':hashlib.sha256(references[0].read_bytes()).hexdigest() if len(references)==1 else None})
            replay=operation('replay');checks.append({'check':'historical-receipt-replay','passed':replay['receipt']==initial['receipt']})
            operation('upgrade');check('stored-upgrade-does-not-reload-native','Verify a synthetic bundle.')
            operation('publish-upgrade');check('native-upgrade-excludes-history','Verify a revised synthetic bundle.')
            operation('rollback');check('native-rollback-restores-first','Verify a synthetic bundle.')
            operation('deactivate');check('deactivation-excludes-retained-generations',count=0)
            operation('restore');check('restore-after-deactivation','Verify a synthetic bundle.')
            check('sibling-isolation',count=0,directory=sibling)
        finally:
            if native:native.close()
    return {'schema_version':1,'harness':args.harness,'version':version,'kind':'go-acp-placement-fixture' if acp_adapter else 'go-native-placement-fixture',
      'adapter_version':adapter_version,'discovery_mode':'fresh ACP session with isolated offline provider' if acp_adapter else 'native discovery',
      'checks':checks,'limitations':['Only disposable synthetic Git workspaces were changed.',('No model turn, production provider/authentication, native trust decision or existing-session refresh was tested.' if acp_adapter else 'No model turn, ACP, native trust decision or active-session behavior was tested.'),'Pi invokes its installed directory loader, not a trusted session.','Remote activation remains unexposed pending external-process coverage, version/mode gates and the operator workflow.','The node receipt keeps loaded unknown; the separate native probe observes discovery.']}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--harness',choices=list(ROOTS),required=True);parser.add_argument('--binary',required=True)
    parser.add_argument('--codex-acp-adapter',help='Probe fresh ACP sessions using the adapter bundled engine and isolated offline provider')
    parser.add_argument('--node-test-binary',required=True);parser.add_argument('--pi-skills-module');parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args()
    if args.output.exists():parser.error('preserve existing evidence; choose a new output')
    result=probe(args);args.output.write_text(json.dumps(result,indent=2)+'\n')
    failures=[c['check'] for c in result['checks'] if not c['passed']]
    print(json.dumps({'harness':args.harness,'version':result['version'],'failures':failures}));raise SystemExit(bool(failures))
