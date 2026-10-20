#!/usr/bin/env python3
"""Prepare a NEW isolated reviewed station root from one pinned OCI image.
No existing runtime/container is stopped, changed or pruned. Run as root on Linux.
"""
import json, os, pathlib, subprocess, sys, uuid
IMAGE = 'docker.io/library/node@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32'
DIGEST = IMAGE.split('@')[1]
if len(sys.argv) != 2 or sys.platform != 'linux' or os.geteuid() != 0:
    raise SystemExit('usage (Linux root): prepare-salaam-station-runtime.py NEW_ABSOLUTE_ROOT')
root = pathlib.Path(sys.argv[1])
if not root.is_absolute() or root.exists() or root.parent.resolve() != root.parent or any(c.isspace() for c in str(root)):
    raise SystemExit('Choose a new canonical absolute path in an owned preparation directory')
subprocess.run(['docker', 'pull', IMAGE], check=True)
info = json.loads(subprocess.check_output(['docker','image','inspect',IMAGE]))[0]
if not any(v.endswith('@'+DIGEST) for v in info.get('RepoDigests', [])):
    raise SystemExit('Pulled image does not carry the pinned repository digest')
name = 'salaam-runtime-export-'+uuid.uuid4().hex
subprocess.run(['docker','create','--name',name,IMAGE], check=True, stdout=subprocess.DEVNULL)
root.mkdir(mode=0o700)
try:
    export = subprocess.Popen(['docker','export',name], stdout=subprocess.PIPE)
    try:
        subprocess.run(['tar','--extract','--directory',str(root),'--no-same-owner'],stdin=export.stdout,check=True)
        export.stdout.close()
        if export.wait() != 0: raise RuntimeError('OCI export failed')
    finally:
        if export.poll() is None: export.kill(); export.wait()
finally:
    subprocess.run(['docker','rm',name],check=True,stdout=subprocess.DEVNULL)
# Complete required mount points before the immutable metadata fingerprint.
for p in ['workspace','proc','sys','dev','run','run/host','run/user','sys/fs/cgroup','dev/pts','dev/mqueue','tmp','var/tmp','dev/shm']:
    (root/p).mkdir(parents=True,exist_ok=True)
for p in ['run/salaam-command','run/host/os-release']:
    (root/p).touch(exist_ok=True)
# Reviewed transformation: no inherited group/other write, trusted root ownership.
# Sticky tmp paths are covered by bounded private tmpfs at execution.
for directory, dirs, files in os.walk(root, followlinks=False):
    for item in [pathlib.Path(directory),*(pathlib.Path(directory)/n for n in files)]:
        if item.is_symlink(): continue
        os.chown(item,0,0)
        os.chmod(item,item.stat().st_mode & 0o7777 & ~0o022 & ~0o6000)
os.chmod(root,0o755)
receipt={'version':1,'profile':'linux-systemd-station-v1','root':str(root),'image':IMAGE,'repository_digest':DIGEST,'image_id':info['Id'],'transformation':'export-v1-root-owner-no-setid-no-group-other-write-mountpoints'}
receipt_path = root.parent/(root.name+'-preparation.json')
with open(receipt_path,'x') as f: json.dump(receipt,f,indent=2); f.write('\n')
os.chmod(receipt_path,0o600)
print(json.dumps(receipt))
