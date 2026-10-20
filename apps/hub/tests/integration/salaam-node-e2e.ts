/** Real Hub gateway + authenticated Go node + Salaam daemon + pinned Pi.
 * Synthetic Accounts principals and board-run ownership; no live model/provider credentials.
 * SALAAM_REPO=/path/to/salaam DATABASE_URL=postgres://agentpod:agentpod-dev-password@127.0.0.1:5434/agentpod bun tests/integration/salaam-node-e2e.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { generateKeyPair, exportJWK } from "jose";
import { SALAAM_MCP_FIXTURE_TOOLS } from "../fixtures/salaam-mcp-tools";

const stationMode = process.env.SALAAM_STATION_REHEARSAL === "1";
const mcpMode = process.env.SALAAM_MCP_REHEARSAL === "1" || stationMode;
if (stationMode) process.umask(0o077);
if (stationMode)
  assert(
    process.platform === "linux" &&
      process.getuid?.() === 0 &&
      process.env.SALAAM_STATION_RUNTIME_ROOT &&
      process.env.SALAAM_STATION_RUNTIME_IMAGE,
    "Station rehearsal needs an isolated Linux systemd host, root controller and verified prepared runtime image root",
  );

const repo = resolve(process.env.SALAAM_REPO ?? "");
assert(
  existsSync(join(repo, "test/fixtures/agentpod-service.mjs")),
  "Set SALAAM_REPO to the source checkout under test",
);
const database = new URL(process.env.DATABASE_URL ?? "http://missing");
assert(
  ["127.0.0.1", "localhost"].includes(database.hostname) &&
    database.port === "5434" &&
    database.pathname === "/agentpod",
  "Use only the isolated pgvector test database on loopback:5434",
);
const dir = realpathSync(mkdtempSync("/tmp/sal-m191-")),
  workspace = join(dir, "workspace"),
  state = join(dir, "state"),
  home = join(dir, "home");
for (const path of [workspace, state, home]) mkdirSync(path, { mode: 0o700 });
if (stationMode) {
  mkdirSync(join(workspace, "src"));
  for (let i = 0; i < 50000; i++)
    writeFileSync(
      join(workspace, "src", `file-${String(i).padStart(5, "0")}.txt`),
      "source\n",
    );
  writeFileSync(join(workspace, "counter.txt"), "before\n");
  writeFileSync(join(workspace, ".env"), "synthetic-private-canary-only", {
    mode: 0o600,
  });
}
const hex = () => randomUUID().replaceAll("-", "").slice(0, 20);
const cfg = {
  mcpRehearsal: mcpMode,
  fixtureSigningKey: mcpMode
    ? await exportJWK(
        (await generateKeyPair("EdDSA", { extractable: true })).privateKey,
      )
    : undefined,
  userId: "prn_" + hex(),
  principalId: "prn_" + hex(),
  otherPrincipalId: "prn_" + hex(),
  nodeId: "node_" + hex(),
  nodeSecret: randomUUID() + randomUUID(),
  stationId: "station_" + hex(),
  stationKey:
    "salaam:" +
    createHash("sha256").update(workspace).digest("hex").slice(0, 16),
  workspace,
  port: 0,
};
const cfgPath = join(dir, "fixture.json"),
  pins = join(dir, "pins.json");
writeFileSync(cfgPath, JSON.stringify(cfg), { mode: 0o600 });
writeFileSync(
  pins,
  JSON.stringify({
    version: 1,
    organization_id: "org_00000000000000000000",
    node_id: cfg.nodeId,
    station_key: cfg.stationKey,
    workspace,
  }),
  { mode: 0o600 },
);
const cleanEnv = {
  PATH: process.env.PATH!,
  HOME: home,
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  LANG: "en_US.UTF-8",
};
const node = String(
  Bun.spawnSync(["node", "-p", "process.execPath"]).stdout,
).trim();
const nodeDirectory = resolve(import.meta.dir, "../../../node-agent"),
  hubDirectory = resolve(import.meta.dir, "../..");
const binary = join(dir, "agentpod-node");

function sourceEvidence(cwd: string) {
  if (!existsSync(join(cwd, ".git"))) {
    const receipt = JSON.parse(
      readFileSync(join(cwd, ".salaam-source-evidence.json"), "utf8"),
    );
    assert.equal(receipt.version, 1);
    assert(/^[a-f0-9]{40}$/.test(receipt.base_commit));
    for (const [file, expected] of Object.entries(receipt.files)) {
      assert(
        typeof file === "string" &&
          !file.startsWith("/") &&
          !file.split("/").includes(".."),
      );
      assert.equal(
        createHash("sha256")
          .update(readFileSync(join(cwd, file)))
          .digest("hex"),
        expected,
        "Packaged source changed: " + file,
      );
    }
    return {
      base_commit: receipt.base_commit,
      changes_sha256: receipt.changes_sha256,
      packaged_files_verified: Object.keys(receipt.files).length,
    };
  }
  const sha = createHash("sha256").update(
    execFileSync(
      "git",
      ["-c", "safe.directory=" + cwd, "diff", "HEAD", "--binary"],
      { cwd },
    ),
  );
  for (const file of execFileSync(
    "git",
    [
      "-c",
      "safe.directory=" + cwd,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { cwd, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort())
    sha.update(file + "\0").update(readFileSync(join(cwd, file)));
  return {
    base_commit: execFileSync(
      "git",
      ["-c", "safe.directory=" + cwd, "rev-parse", "HEAD"],
      {
        cwd,
        encoding: "utf8",
      },
    ).trim(),
    changes_sha256: sha.digest("hex"),
  };
}

const checked = JSON.parse(
  readFileSync(
    join(
      hubDirectory,
      "../../packages/contract/src/fixtures/salaam-authority-v1.json",
    ),
    "utf8",
  ),
);
assert.deepEqual(
  JSON.parse(
    readFileSync(
      join(repo, "test/fixtures/agentpod-authority-v1.json"),
      "utf8",
    ),
  ),
  checked,
  "Both consumers must use the same authority corpus",
);
const acpCorpus = readFileSync(
  join(hubDirectory, "../../packages/contract/src/fixtures/salaam-acp-v1.json"),
  "utf8",
);
assert.deepEqual(
  JSON.parse(
    readFileSync(join(repo, "test/fixtures/agentpod-acp-v1.json"), "utf8"),
  ),
  JSON.parse(acpCorpus),
  "Producer and Hub must consume the same ACP outcome corpus",
);
const build = Bun.spawn(
  ["go", "build", "-p", "1", "-o", binary, "./cmd/agentpod-node"],
  {
    cwd: nodeDirectory,
    stdout: "pipe",
    stderr: "pipe",
  },
);
const buildErrors = new Response(build.stderr).text();
assert.equal(await build.exited, 0, await buildErrors);
let daemon: ReturnType<typeof Bun.spawn> | undefined,
  nodeProcess: ReturnType<typeof Bun.spawn> | undefined,
  hub: ReturnType<typeof bootHub> | undefined;
const runtimeMode = process.env.SALAAM_RUNTIME_REHEARSAL === "1" || mcpMode;
const manifestPath = join(dir, "host.json");
const cases: string[] = [];
const record = (name: string) => {
  cases.push(name);
  console.log("PASS " + name);
};
const logs: string[] = [];
let acceptancePassed = false;
async function until<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  timeout = 30000,
): Promise<T> {
  const end = Date.now() + timeout;
  let last: T;
  do {
    last = await read();
    if (accept(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < end);
  throw Error("Rehearsal condition timed out: " + JSON.stringify(last!));
}
async function kill(p: ReturnType<typeof Bun.spawn> | undefined) {
  if (p && p.exitCode === null) {
    p.kill(9);
    await p.exited;
  }
}
function collect(p: ReturnType<typeof Bun.spawn>) {
  if (!p.stderr || typeof p.stderr === "number")
    throw Error("Expected a captured child error stream");
  void new Response(p.stderr).text().then((s) => logs.push(s.slice(-12000)));
}
async function bootDaemon() {
  const p = Bun.spawn(
    [node, join(repo, "test/fixtures/agentpod-service.mjs"), state, pins],
    { env: cleanEnv, stdout: "pipe", stderr: "pipe" },
  );
  collect(p);
  const reader = p.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  assert(
    !first.done && String(Buffer.from(first.value)).includes("ready"),
    "Salaam daemon did not become ready",
  );
  daemon = p;
}
function bootHub() {
  const p = Bun.spawn(
    ["bun", join(hubDirectory, "tests/fixtures/salaam-hub-driver.ts"), cfgPath],
    {
      cwd: hubDirectory,
      env: {
        ...cleanEnv,
        DATABASE_URL: process.env.DATABASE_URL!,
        NODE_ENV: "test",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  collect(p);
  const waiting = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let n = 0;
  let ready!: (port: number) => void, rejectReady!: (e: Error) => void;
  let didStart = false;
  const started = new Promise<number>((r, j) => {
    ready = r;
    rejectReady = j;
  });
  const readyTimer = setTimeout(
    () => rejectReady(Error("Hub startup timed out")),
    30000,
  );
  void (async () => {
    const reader = p.stdout.getReader();
    let pending = "";
    const decoder = new TextDecoder();
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      pending += decoder.decode(item.value, { stream: true });
      let at: number;
      while ((at = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        try {
          const value = JSON.parse(line);
          if (value.kind === "ready") {
            didStart = true;
            clearTimeout(readyTimer);
            ready(value.port);
          } else if (value.kind === "result") {
            const item = waiting.get(value.id);
            if (item) {
              clearTimeout(item.timer);
              waiting.delete(value.id);
              value.error
                ? item.reject(Error(value.error))
                : item.resolve(value.result);
            }
          } else logs.push(line.slice(0, 1000));
        } catch {
          logs.push(line.slice(0, 1000));
        }
      }
    }
  })();
  void p.exited.then(() => {
    clearTimeout(readyTimer);
    if (!didStart) rejectReady(Error("Hub exited before readiness"));
    for (const w of waiting.values()) {
      clearTimeout(w.timer);
      w.reject(Error("Hub process exited"));
    }
    waiting.clear();
  });
  const request = (method: string, params: object = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++n;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(Error("Hub request timed out: " + method));
      }, 120000);
      waiting.set(id, { resolve, reject, timer });
      p.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      void p.stdin.flush();
    });
  return { p, started, request };
}
function bootNode() {
  const p = Bun.spawn([binary, "run"], {
    env: cleanEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  collect(p);
  void new Response(p.stdout).text().then((s) => logs.push(s.slice(-4000)));
  nodeProcess = p;
}
async function snapshot(id: string) {
  const p = Bun.spawn(
    [
      node,
      join(repo, "bin/salaam.mjs"),
      "session",
      "inspect",
      id,
      "--state",
      state,
    ],
    { env: cleanEnv, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  assert.equal(await p.exited, 0, err);
  return JSON.parse(out);
}
async function stopped() {
  return until(
    () => hub!.request("readiness"),
    (r) => r.ready === true,
  );
}
function hold() {
  for (const f of ["release-probe", "probe-entered"])
    if (existsSync(join(workspace, f))) unlinkSync(join(workspace, f));
}
const entered = () =>
  until(() => existsSync(join(workspace, "probe-entered")), Boolean);
const release = () =>
  writeFileSync(join(workspace, "release-probe"), "release");
async function runtimeCases() {
  const hostStatus = () =>
    JSON.parse(readFileSync(join(state, "host/status.json"), "utf8"));
  const hostCli = (...args: string[]) =>
    execFileSync(node, [join(repo, "bin/salaam.mjs"), ...args], {
      env: cleanEnv,
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const health = () => {
    try {
      return JSON.parse(hostCli("service", "status", "--state", state));
    } catch {
      return null;
    }
  };
  const initial = await until(health, (h) => !!h?.host_manifest_digest);
  assert.equal(initial.coding_root, null);
  const supervisor = hostStatus().supervisor_pid;
  record(
    "real Go node cold-starts reviewed private-runtime daemon with no Docker executor",
  );
  const first = await hub!.request("create"),
    saved = await hub!.request("record", { id: first.id });
  const session = saved.executionAuthority.sessionId,
    requestId = randomUUID();
  await hub!.request("prompt", {
    id: first.id,
    text: "Hello from the private runtime",
    requestId,
  });
  const receipt = await until(
    () => hub!.request("receipt", { id: first.id, requestId }),
    (r) => r?.state === "completed",
  );
  const attempt = receipt.attemptId;
  await kill(nodeProcess);
  bootNode();
  await until(() => hub!.request("online"), Boolean);
  await hub!.request("prompt", {
    id: first.id,
    text: "Hello from the private runtime",
    requestId,
  });
  assert.equal(
    (await hub!.request("receipt", { id: first.id, requestId })).attemptId,
    attempt,
  );
  assert.equal(
    (await hub!.request("record", { id: first.id })).executionAuthority
      .sessionId,
    session,
  );
  record(
    "node restart uses private Node and preserves original logical prompt, session and attempt",
  );
  const oldDaemon = hostStatus().daemon_pid;
  process.kill(oldDaemon, "SIGKILL");
  await until(
    hostStatus,
    (s) => s.daemon_pid !== oldDaemon && s.healthy,
    15000,
  );
  await hub!.request("renew", { id: first.id });
  assert.equal(
    (await hub!.request("status", { id: first.id })).authorized,
    true,
  );
  assert.equal(hostStatus().supervisor_pid, supervisor);
  assert.equal(
    (await hub!.request("record", { id: first.id })).executionAuthority
      .sessionId,
    session,
  );
  record(
    "supervised daemon restart requires fresh renewal and retains the durable admission",
  );
  const reviewed = readFileSync(manifestPath, "utf8");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      ...JSON.parse(reviewed),
      build_digest: "partial-upgrade",
    }),
  );
  await assert.rejects(
    hub!.request("renew", { id: first.id }),
    /startup|authority|manifest|denied|failed/i,
  );
  await until(health, (h) => h === null, 15000);
  record(
    "partial upgrade blocks node renewal and supervisor stops the unmatched daemon",
  );
  writeFileSync(manifestPath, reviewed);
  hostCli("host", "start", "--manifest", manifestPath);
  await stopped();
  await assert.rejects(
    hub!.request("renew", { id: first.id }),
    /not active|revoked|authority/i,
  );
  assert.equal((await snapshot(session)).attempts.length, 1);
  assert.equal((await hub!.request("status", { id: first.id })).revoked, true);
  record(
    "restoring reviewed runtime preserves state without replay or resurrection of revoked authority",
  );
  const replacement = await hub!.request("create");
  assert.notEqual(
    (await hub!.request("record", { id: replacement.id })).executionAuthority
      .sessionId,
    session,
  );
  await hub!.request("end", { id: replacement.id });
  await stopped();
  const revoked = await hub!.request("status", { id: replacement.id });
  assert(revoked.revoked && revoked.owned_execution_stopped);
  record(
    "explicit end still revokes and confirms owned execution stopped after runtime recovery",
  );
}
function canonicalFixture(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(canonicalFixture).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonicalFixture(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value)!;
}
const mcpFingerprint = (value: unknown) =>
  createHash("sha256").update(canonicalFixture(value)).digest("hex");
function prepareStationConfig(): string {
  const file = join(dir, "station-config.json");
  const script = `import{readFileSync,writeFileSync,realpathSync}from'node:fs';import{createHash}from'node:crypto';import{stationRuntimeFingerprint,stationWorkspaceIdentity}from${JSON.stringify(join(repo, "dist/src/station-config.js"))};const [file,workspace,binary,runtime,image]=process.argv.slice(1);const pin=p=>({path:realpathSync(p),sha256:createHash('sha256').update(readFileSync(realpathSync(p))).digest('hex')});writeFileSync(file,JSON.stringify({version:1,kind:'linux-systemd-station-v1',workspace,workspace_identity:stationWorkspaceIdentity(workspace),files:pin(binary),systemd_run:pin('/usr/bin/systemd-run'),systemctl:pin('/usr/bin/systemctl'),runtime_root:runtime,runtime_fingerprint:stationRuntimeFingerprint(runtime),runtime_image_digest:image}),{mode:0o600});`;
  execFileSync(
    node,
    [
      "--input-type=module",
      "-e",
      script,
      file,
      workspace,
      binary,
      realpathSync(process.env.SALAAM_STATION_RUNTIME_ROOT!),
      process.env.SALAAM_STATION_RUNTIME_IMAGE!,
    ],
    { env: cleanEnv, timeout: 30000 },
  );
  return file;
}
function stationRows(sql: string, params: unknown[] = []): any[] {
  const script = `import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(process.argv[1],{readOnly:true});try{console.log(JSON.stringify(db.prepare(process.argv[2]).all(...JSON.parse(process.argv[3]))))}finally{db.close()}`;
  return JSON.parse(
    execFileSync(
      node,
      [
        "--input-type=module",
        "-e",
        script,
        join(state, "journal.sqlite"),
        sql,
        JSON.stringify(params),
      ],
      { env: cleanEnv, encoding: "utf8", timeout: 10000 },
    ),
  );
}
function stationOperator(path: string, body?: unknown): any {
  const script = `import{call}from${JSON.stringify(join(repo, "dist/src/transport.js"))};console.log(JSON.stringify(await call(process.argv[1],process.argv[2],JSON.parse(process.argv[3])??undefined)));`;
  return JSON.parse(
    execFileSync(
      node,
      [
        "--input-type=module",
        "-e",
        script,
        join(state, "operator.sock"),
        path,
        JSON.stringify(body ?? null),
      ],
      { env: cleanEnv, encoding: "utf8", timeout: 10000 },
    ),
  );
}
async function stationCases() {
  assert.equal(stationMode, true);
  const first = await hub!.request("create"),
    saved = await hub!.request("record", { id: first.id }),
    session = saved.executionAuthority.sessionId;
  assert(
    (await snapshot(session)).capabilities.includes("protected-station-v1"),
  );
  const send = async (args: unknown, requestId = randomUUID()) => {
    await hub!.request("prompt", {
      id: first.id,
      text: "[station] " + JSON.stringify(args),
      requestId,
    });
    const receipt = await until(
      () => hub!.request("receipt", { id: first.id, requestId }),
      (r) =>
        ["completed", "interrupted", "cancelled", "failed"].includes(r.state),
    );
    await until(
      () => hub!.request("record", { id: first.id }),
      (r) => r.status === "idle",
    );
    assert.equal(
      receipt.state,
      "completed",
      "Station prompt must finish successfully",
    );
    return receipt;
  };
  await send({ action: "search", query: "counter.txt" });
  const read = stationRows(
    "SELECT response FROM requests WHERE actor LIKE ? ORDER BY rowid DESC LIMIT 1",
    ["station-read:" + session + ":%"],
  )[0];
  const index = JSON.parse(read.response);
  assert(index.files >= 50000);
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0].path, "counter.txt");
  const logical = randomUUID(),
    text =
      "[station] " +
      JSON.stringify({
        action: "patch",
        path: "counter.txt",
        expected_tree: index.tree_digest,
        expected_hash: createHash("sha256").update("before\n").digest("hex"),
        content: "after\n",
      });
  const pending = hub!.request("prompt", {
    id: first.id,
    text,
    requestId: logical,
  });
  void pending.catch(() => {});
  const events = await until(
    () => hub!.request("events", { id: first.id }),
    (e) => e.some((v: any) => v.type === "permission-request"),
  );
  const permission = events
      .filter((v: any) => v.type === "permission-request")
      .at(-1),
    option = permission.payload.options.find(
      (v: any) => v.kind === "allow_once",
    );
  assert(option);
  assert.equal(
    readFileSync(join(workspace, "counter.txt"), "utf8"),
    "before\n",
  );
  await hub!.request("permission", {
    id: first.id,
    seq: permission.seq,
    optionId: option.optionId,
  });
  await pending;
  const receipt = await until(
    () => hub!.request("receipt", { id: first.id, requestId: logical }),
    (r) => r.state === "completed",
  );
  await until(
    () => hub!.request("record", { id: first.id }),
    (r) => r.status === "idle",
  );
  const patch = stationRows(
    "SELECT * FROM station_calls WHERE attempt_id=? AND kind='patch'",
    [receipt.attemptId],
  )[0];
  assert.equal(patch.state, "returned");
  assert.equal(patch.helper_state, "stopped");
  assert(patch.helper_pid > 0 && patch.helper_identity);
  assert.equal(readFileSync(join(workspace, "counter.txt"), "utf8"), "after\n");
  const applied = JSON.parse(patch.result_json);
  assert.equal(
    applied.sha256,
    createHash("sha256").update("after\n").digest("hex"),
  );
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const check = await send({
    action: "check",
    expected_tree: applied.tree_digest,
    command:
      "node -e " +
      quote(
        "const fs=require('fs'),assert=require('assert/strict');assert.equal(fs.readFileSync('/workspace/counter.txt').toString('hex'),'61667465720a');assert.throws(()=>fs.readFileSync('/workspace/.env'));assert.throws(()=>fs.writeFileSync('/workspace/counter.txt','bad'));assert.notEqual(process.getuid(),0);assert.equal(process.env.NO_PROXY,undefined);assert.deepEqual(fs.readdirSync('/sys/class/net'),['lo']);console.log('actual-root-check-ok');",
      ),
  });
  const checked = stationRows(
      "SELECT * FROM station_calls WHERE attempt_id=? AND kind='check'",
      [check.attemptId],
    )[0],
    result = JSON.parse(checked.result_json);
  assert.equal(checked.state, "returned");
  assert.equal(result.verified_check, true);
  assert.equal(result.cleanup.observed_empty, true);
  record(
    "real Go node schema5 cold start exposes protected station tools; >=50000-file metadata, human-bound actual-root patch and isolated revision-bound check pass",
  );
  await kill(hub!.p);
  hub = bootHub();
  assert.equal(await hub.started, cfg.port);
  await until(() => hub!.request("online"), Boolean);
  await until(
    () => hub!.request("record", { id: first.id }),
    (r) => r.status === "idle",
  );
  await kill(nodeProcess);
  bootNode();
  await until(() => hub!.request("online"), Boolean);
  await until(
    () => hub!.request("record", { id: first.id }),
    (r) => r.status === "idle",
  );
  const restored = await hub.request("record", { id: first.id });
  assert.equal(restored.executionAuthority.sessionId, session);
  assert.equal(
    (await hub.request("prompt", { id: first.id, text, requestId: logical }))
      .attemptId,
    receipt.attemptId,
  );
  assert.equal(
    stationRows("SELECT count(*) AS n FROM station_calls WHERE attempt_id=?", [
      receipt.attemptId,
    ])[0].n,
    1,
  );
  assert.equal(readFileSync(join(workspace, "counter.txt"), "utf8"), "after\n");
  record(
    "Separate Hub and node reconnects retain the station session and original reviewed patch attempt without a second filesystem dispatch",
  );
  const longId = randomUUID(),
    long = hub.request("prompt", {
      id: first.id,
      requestId: longId,
      text:
        "[station] " +
        JSON.stringify({
          action: "check",
          expected_tree: applied.tree_digest,
          command:
            "node -e " +
            quote(
              "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)",
            ),
        }),
    });
  void long.catch(() => {});
  const unit = await until<any>(
    () =>
      stationRows(
        "SELECT u.* FROM station_units u JOIN station_calls c ON c.id=u.call_id WHERE c.session_id=? AND u.state='running' ORDER BY u.rowid DESC LIMIT 1",
        [session],
      )[0],
    Boolean,
  );
  const old = JSON.parse(readFileSync(join(state, "host/status.json"), "utf8"));
  process.kill(old.daemon_pid, "SIGKILL");
  await until(
    () => JSON.parse(readFileSync(join(state, "host/status.json"), "utf8")),
    (s) => s.daemon_pid !== old.daemon_pid && s.healthy,
    30000,
  );
  const recovered = stationRows("SELECT * FROM station_units WHERE id=?", [
    unit.id,
  ])[0];
  assert.equal(recovered.state, "stopped");
  assert.equal(JSON.parse(recovered.stop_json).observed_empty, true);
  assert.equal(
    stationRows("SELECT count(*) AS n FROM station_units WHERE call_id=?", [
      unit.call_id,
    ])[0].n,
    1,
  );
  assert.notEqual(
    stationRows("SELECT state FROM station_calls WHERE id=?", [unit.call_id])[0]
      .state,
    "returned",
  );
  await long.catch(() => {});
  await hub.request("end", { id: first.id });
  await until(
    () => hub!.request("status", { id: first.id }),
    (r) =>
      r.revoked &&
      r.owned_execution_stopped &&
      r.unresolved_operations.length === 0,
  );
  record(
    "daemon SIGKILL stops the exact inherited systemd invocation/cgroup and preserves a failed check rather than replaying or verifying it",
  );
  for (const mode of ["revoke", "lease-expiry"]) {
    const root: any = await hub.request("create");
    const rootRecord: any = await hub.request("record", { id: root.id });
    const sid: string = rootRecord.executionAuthority.sessionId;
    const requestId = randomUUID(),
      text =
        "[station] " +
        JSON.stringify({
          action: "check",
          expected_tree: applied.tree_digest,
          command:
            "node -e " +
            quote(
              "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)",
            ),
        });
    let deadline = 0,
      running: Promise<unknown> = Promise.resolve();
    if (mode === "lease-expiry") {
      await kill(hub.p);
      await kill(nodeProcess);
      deadline = stationRows(
        "SELECT expires_at FROM agentpod_admissions WHERE session_id=?",
        [sid],
      )[0].expires_at;
      // Use the real ninety-second lease. Start the command in its final fifteen
      // seconds via the existing private operator surface, without a Hub renewal.
      // This distinguishes authority expiry from the thirty-second runtime cap.
      await until(
        () => deadline - Date.now(),
        (n) => n <= 15000,
        95000,
      );
      const view = stationOperator("/v1/sessions/" + sid + "/snapshot"),
        client = "station-lease-proof",
        control = stationOperator("/v1/sessions/" + sid + "/control", {
          request_id: randomUUID(),
          client_id: client,
          action: "takeover",
          expected_epoch: view.control.epoch,
        });
      const ready = stationOperator("/v1/sessions/" + sid);
      stationOperator("/v1/sessions/" + sid + "/submissions", {
        request_id: requestId,
        expected_revision: ready.revision,
        client_id: client,
        token: control.token,
        text,
      });
    } else {
      running = hub.request("prompt", { id: root.id, requestId, text });
      void running.catch(() => {});
    }
    const active = await until<any>(
      () =>
        stationRows(
          "SELECT u.* FROM station_units u JOIN station_calls c ON c.id=u.call_id WHERE c.session_id=? AND u.state='running' ORDER BY u.rowid DESC LIMIT 1",
          [sid],
        )[0],
      Boolean,
    );
    if (mode === "revoke") await hub.request("end", { id: root.id });
    await until(
      () =>
        stationRows("SELECT * FROM station_units WHERE id=?", [active.id])[0],
      (u) => u.state === "stopped",
      25000,
    );
    const ended: any = stationRows("SELECT * FROM station_units WHERE id=?", [
      active.id,
    ])[0];
    assert.equal(JSON.parse(ended.stop_json).observed_empty, true);
    assert.notEqual(
      stationRows("SELECT state FROM station_calls WHERE id=?", [
        active.call_id,
      ])[0].state,
      "returned",
    );
    if (mode === "lease-expiry") {
      assert(
        Date.now() >= deadline,
        "The actual admission deadline must have elapsed",
      );
      hub = bootHub();
      await hub.started;
      bootNode();
      await until(() => hub!.request("online"), Boolean);
      await hub.request("end", { id: root.id });
    }
    await until(
      () => hub!.request("status", { id: root.id }),
      // A stopped process alone is not the barrier for admitting the next root.
      // The in-flight operation must also have a durable terminal settlement.
      (r) =>
        r.revoked &&
        r.owned_execution_stopped &&
        r.unresolved_operations.length === 0,
    );
    await running.catch(() => {});
    assert.equal(
      stationRows("SELECT count(*) AS n FROM station_units WHERE call_id=?", [
        active.call_id,
      ])[0].n,
      1,
    );
    record(
      "active station command and descendant stop with exact cgroup receipt on " +
        mode +
        "; no verified check or replay",
    );
  }
}
async function prepareMcpHost() {
  const configDirs = [
    join(home, "Library/Application Support/agentpod-node"),
    join(home, ".config/agentpod-node"),
  ];
  const proxyState = await until(
    () => configDirs.map((p) => join(p, "mcp-proxy.json")).find(existsSync),
    (p) => !!p,
  );
  const listen = JSON.parse(readFileSync(proxyState!, "utf8")).listen as string;
  assert(/^127\.0\.0\.1:\d+$/.test(listen));
  const profile = {
    version: 1,
    scope: "agentpod-proxy",
    proxy_origin: "http://" + listen,
    servers: Object.entries(SALAAM_MCP_FIXTURE_TOOLS).map(([name, tools]) => ({
      name,
      protocol_version: "2025-11-25",
      catalog_digest: mcpFingerprint(
        [...tools].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        ),
      ),
      tools: tools.map((tool) => ({
        name: tool.name,
        schema_digest: mcpFingerprint(tool),
        policy: tool.name === "fixture_mutate" ? "approval" : "read",
      })),
    })),
    limits: {
      request_bytes: 32768,
      response_bytes: 262144,
      timeout_ms: 30000,
      calls_per_attempt: 16,
    },
  };
  const profileFile = join(dir, "managed-mcp.json"),
    input = join(dir, "host-config.json");
  writeFileSync(profileFile, JSON.stringify(profile), { mode: 0o600 });
  writeFileSync(
    input,
    JSON.stringify({
      mode: "agentpod",
      state,
      agentpod_config: pins,
      mcp_config: profileFile,
      ...(stationMode ? { station_config: prepareStationConfig() } : {}),
    }),
    { mode: 0o600 },
  );
  const planned = execFileSync(
    node,
    [join(repo, "bin/salaam.mjs"), "host", "plan", "--config", input],
    { env: cleanEnv, encoding: "utf8" },
  );
  assert.equal(JSON.parse(planned).schema, stationMode ? 5 : 3);
  writeFileSync(manifestPath, planned, { mode: 0o600 });
  // A wrong key cannot reach either upstream; do not read or print the real proxy key.
  const refused = await fetch(
    `${profile.proxy_origin}/stations/${cfg.stationId}/mcp/superlibrary`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Agentpod-Proxy-Key": "deliberately-wrong-offline-fixture-key",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    },
  );
  assert.equal(refused.status, 401);
  record(
    "node-owned proxy rejects an unassigned key before the station token or MCP upstream",
  );
}
async function mcpCases() {
  const first = await hub!.request("create"),
    row = await hub!.request("record", { id: first.id }),
    session = row.executionAuthority.sessionId;
  assert.equal(row.mcpProxyRequested, true);
  assert((await snapshot(session)).capabilities.includes("managed-mcp-v1"));
  const logical = randomUUID(),
    text =
      "[mcp] " +
      JSON.stringify({
        action: "call",
        server: "superlibrary",
        tool: "library_search",
        arguments: { query: "synthetic scoped station memory" },
      });
  await hub!.request("prompt", { id: first.id, text, requestId: logical });
  const receipt = await until(
    () => hub!.request("receipt", { id: first.id, requestId: logical }),
    (r) => r.state === "completed",
  );
  let observed = await hub!.request("mcp-observed");
  assert.equal(observed.calls.length, 1);
  assert.equal(observed.calls[0].principal, cfg.principalId);
  assert.equal((await snapshot(session)).attempts.length, 1);
  record(
    "authenticated Hub → node private assignment → persisted proxy → daemon → pinned Pi executes one scoped MCP read",
  );

  await kill(hub!.p);
  hub = bootHub();
  assert.equal(await hub.started, cfg.port);
  await until(() => hub!.request("online"), Boolean);
  await until(
    () => hub!.request("record", { id: first.id }),
    (r) => r.status === "idle",
  );
  const restored = await hub.request("record", { id: first.id });
  assert.equal(restored.mcpProxyRequested, true);
  assert.equal(restored.executionAuthority.sessionId, session);
  assert.equal(
    (await hub.request("prompt", { id: first.id, text, requestId: logical }))
      .attemptId,
    receipt.attemptId,
  );
  observed = await hub.request("mcp-observed");
  assert.equal(observed.calls.length, 0);
  record(
    "Hub SIGKILL restores managed MCP intent and the same session/receipt without replaying a tool",
  );

  execFileSync(binary, ["mcp-proxy", "rotate", cfg.stationId], {
    env: cleanEnv,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  });
  await kill(nodeProcess);
  bootNode();
  await until(() => hub!.request("online"), Boolean);
  await until(
    () => hub!.request("record", { id: first.id }),
    (r) => r.status === "idle",
  );
  assert.equal(
    (await hub.request("prompt", { id: first.id, text, requestId: logical }))
      .attemptId,
    receipt.attemptId,
  );
  assert.equal((await hub.request("mcp-observed")).calls.length, 0);
  const nextId = randomUUID();
  await hub.request("prompt", {
    id: first.id,
    text:
      "[mcp] " +
      JSON.stringify({
        action: "call",
        server: "superlibrary",
        tool: "library_search",
        arguments: { query: "after node restart and key rotation" },
      }),
    requestId: nextId,
  });
  await until(
    () => hub!.request("receipt", { id: first.id, requestId: nextId }),
    (r) => r.state === "completed",
  );
  assert.equal((await hub.request("mcp-observed")).calls.length, 1);
  assert.equal((await snapshot(session)).attempts.length, 2);
  record(
    "proxy key rotation and node SIGKILL admit a new generation while retaining prior work without duplicate calls",
  );

  let activeRoot = first.id,
    activeSession = session;
  for (const principal of [cfg.otherPrincipalId, cfg.principalId]) {
    await hub.request("end", { id: activeRoot });
    await until(
      () => hub!.request("status", { id: activeRoot }),
      (r) => r.revoked && r.owned_execution_stopped,
    );
    await hub.request("reassign", { principalId: principal });
    const next = await hub.request("create");
    const saved = await hub.request("record", { id: next.id });
    activeRoot = next.id;
    activeSession = saved.executionAuthority.sessionId;
    assert.equal(saved.executionAuthority.binding.principal_id, principal);
    assert.equal((await snapshot(activeSession)).messages.length, 0);
    const requestId = randomUUID();
    await hub.request("prompt", {
      id: activeRoot,
      text:
        "[mcp] " +
        JSON.stringify({
          action: "call",
          server: "superlibrary",
          tool: "library_search",
          arguments: { query: "admitted occupant handoff" },
        }),
      requestId,
    });
    await until(
      () => hub!.request("receipt", { id: activeRoot, requestId }),
      (r) => r.state === "completed",
    );
    assert.equal(
      (await hub.request("mcp-observed")).calls.at(-1).principal,
      principal,
    );
  }
  record(
    "occupant A → B → A advances the private proxy binding and replaces cached station tokens without importing prior conversation state",
  );
  const beforeCalls = (await hub.request("mcp-observed")).calls.length;
  const beforeAttempts = (await snapshot(activeSession)).attempts.length;
  await hub.request("mcp-mode", { hold: true });
  const mutationId = randomUUID(),
    mutating = hub.request("prompt", {
      id: activeRoot,
      text:
        "[mcp] " +
        JSON.stringify({
          action: "call",
          server: "superlibrary",
          tool: "fixture_mutate",
          arguments: { query: "synthetic approved crash proof" },
        }),
      requestId: mutationId,
    });
  void mutating.catch(() => {});
  const permission = await until(
    () => hub!.request("events", { id: activeRoot }),
    (events) => events.some((e: any) => e.type === "permission-request"),
  );
  const question = permission
    .filter((e: any) => e.type === "permission-request")
    .at(-1);
  assert.equal((await hub.request("mcp-observed")).calls.length, beforeCalls);
  const option = question.payload.options.find(
    (o: any) => o.kind === "allow_once",
  );
  assert(option);
  await hub.request("permission", {
    id: activeRoot,
    seq: question.seq,
    optionId: option.optionId,
  });
  await until(
    () => hub!.request("mcp-observed"),
    (o) => o.calls.filter((c: any) => c.tool === "fixture_mutate").length === 1,
  );
  const oldHost = JSON.parse(
    readFileSync(join(state, "host/status.json"), "utf8"),
  );
  process.kill(oldHost.daemon_pid, "SIGKILL");
  await until(
    () => JSON.parse(readFileSync(join(state, "host/status.json"), "utf8")),
    (s) => s.daemon_pid !== oldHost.daemon_pid && s.healthy,
    20000,
  );
  await hub.request("renew", { id: activeRoot }).catch((error) => {
    assert(/revoked|authority|not active/i.test(String(error)));
  });
  const recovered = await until(
    () => snapshot(activeSession),
    (s) => s.operations.some((o: any) => o.state === "outcome_unknown"),
  );
  assert.equal(recovered.attempts.length, beforeAttempts + 1);
  assert.equal(
    recovered.operations.filter((o: any) => o.state === "outcome_unknown")
      .length,
    1,
  );
  observed = await hub.request("mcp-observed");
  assert.equal(observed.calls.length, beforeCalls + 1);
  await mutating.catch(() => {});
  await hub.request("end", { id: activeRoot });
  const stoppedStatus = await until(
    () => hub!.request("status", { id: activeRoot }),
    (s) => s.revoked && s.owned_execution_stopped,
  );
  assert.equal(stoppedStatus.unresolved_operations.length, 1);
  assert.equal(
    (await hub.request("mcp-observed")).calls.filter(
      (c: any) => c.tool === "fixture_mutate",
    ).length,
    1,
  );
  record(
    "daemon SIGKILL after approved HTTP acceptance preserves one unknown effect; explicit root stop confirms local resources without claiming the mutation settled",
  );
}

try {
  if (!runtimeMode) await bootDaemon();
  else if (!mcpMode) {
    const input = join(dir, "host-config.json");
    writeFileSync(
      input,
      JSON.stringify({ mode: "agentpod", state, agentpod_config: pins }),
      { mode: 0o600 },
    );
    const planned = execFileSync(
      node,
      [join(repo, "bin/salaam.mjs"), "host", "plan", "--config", input],
      { env: cleanEnv, encoding: "utf8" },
    );
    writeFileSync(manifestPath, planned, { mode: 0o600 });
  }
  hub = bootHub();
  cfg.port = await hub.started;
  writeFileSync(cfgPath, JSON.stringify(cfg), { mode: 0o600 });
  const nodeConfig = {
    hub: `http://127.0.0.1:${cfg.port}`,
    nodeId: cfg.nodeId,
    nodeSecret: cfg.nodeSecret,
    salaamBinary: join(repo, "bin/salaam.mjs"),
    salaamStateDir: state,
    salaamWorkspace: workspace,
    ...(mcpMode
      ? {
          mcpProxy: {
            stations: [cfg.stationId],
            superlibraryUrl: `http://127.0.0.1:${cfg.port}/mcp-library`,
          },
        }
      : {}),
    ...(runtimeMode
      ? { salaamNodeBinary: realpathSync(node), salaamManifest: manifestPath }
      : {}),
  };
  for (const path of [
    join(home, "Library/Application Support/agentpod-node"),
    join(home, ".config/agentpod-node"),
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(path, "config.json"), JSON.stringify(nodeConfig), {
      mode: 0o600,
    });
  }
  bootNode();
  await until(() => hub!.request("online"), Boolean);
  if (mcpMode) {
    await prepareMcpHost();
    // The HTTP crash proof intentionally leaves an unresolved remote mutation.
    // Keep it last: a new execution root must not bypass that durable fence.
    if (stationMode) await stationCases();
    await mcpCases();
  } else if (runtimeMode) await runtimeCases();
  else {
    const first = await hub.request("create"),
      saved = await hub.request("record", { id: first.id }),
      session = saved.executionAuthority.sessionId;
    assert.equal(
      (await hub.request("status", { id: first.id })).authorized,
      true,
    );
    hold();
    const firstLogical = crypto.randomUUID();
    const firstTurn = hub.request("prompt", {
      id: first.id,
      text: "One durable instruction",
      requestId: firstLogical,
    });
    void firstTurn.catch(() => {});
    await entered();
    const accepted = await until(
      () => hub!.request("receipt", { id: first.id, requestId: firstLogical }),
      (r) => r.state === "accepted",
    );
    const repeated = await hub.request("prompt", {
      id: first.id,
      text: "One durable instruction",
      requestId: firstLogical,
    });
    assert.equal(repeated.attemptId, accepted.attemptId);
    await assert.rejects(
      hub.request("prompt", {
        id: first.id,
        text: "Changed logical input",
        requestId: firstLogical,
      }),
      /different input/,
    );
    release();
    await firstTurn;
    await until(
      () => hub!.request("receipt", { id: first.id, requestId: firstLogical }),
      (r) => r.state === "completed",
    );
    const beforeHistory = await hub.request("events", { id: first.id });
    const sourceIds = beforeHistory
      .filter(
        (e: any) =>
          e.type === "agent-update" &&
          e.payload.sessionUpdate === "agent_message_chunk",
      )
      .map((e: any) => e.payload._meta?.["salaam.dev/updateId"])
      .filter(Boolean);
    assert(sourceIds.length > 0);
    assert.equal((await snapshot(session)).attempts.length, 1);
    record("authenticated Hub → Go node → bound ACP → daemon → real Pi");
    await kill(hub.p);
    hub = bootHub();
    assert.equal(await hub.started, cfg.port);
    await until(() => hub!.request("online"), Boolean);
    await until(
      () => hub!.request("record", { id: first.id }),
      (r) => r.status === "idle",
    );
    assert.equal(
      (await hub.request("record", { id: first.id })).executionAuthority
        .sessionId,
      session,
    );
    assert.equal((await snapshot(session)).attempts.length, 1);
    const recoveredReceipt = await hub.request("prompt", {
      id: first.id,
      text: "One durable instruction",
      requestId: firstLogical,
    });
    assert.equal(recoveredReceipt.attemptId, accepted.attemptId);
    await assert.rejects(
      hub.request("prompt", {
        id: first.id,
        text: "Changed after restart",
        requestId: firstLogical,
      }),
      /different input/,
    );
    const afterHistory = await hub.request("events", { id: first.id });
    assert.equal(
      afterHistory.filter((e: any) => e.type === "user-prompt").length,
      1,
    );
    const recoveredSources = afterHistory
      .filter(
        (e: any) =>
          e.type === "agent-update" &&
          e.payload.sessionUpdate === "agent_message_chunk",
      )
      .map((e: any) => e.payload._meta?.["salaam.dev/updateId"])
      .filter(Boolean);
    assert.equal(new Set(recoveredSources).size, recoveredSources.length);
    assert.equal(recoveredSources.length, sourceIds.length);
    record(
      "logical prompt UUID survives Hub restart; changed input conflicts and load history is not duplicated",
    );
    record("Hub SIGKILL restores the same session without prompt replay");
    hold();
    const secondLogical = crypto.randomUUID();
    const secondTurn = hub.request("prompt", {
      id: first.id,
      text: "Survive node restart",
      requestId: secondLogical,
    });
    void secondTurn.catch(() => {});
    await entered();
    await kill(nodeProcess);
    assert.equal((await snapshot(session)).attempts.length, 2);
    bootNode();
    await until(() => hub!.request("online"), Boolean);
    await until(
      () => hub!.request("status", { id: first.id }),
      (s) => s.authorized,
    );
    release();
    await secondTurn;
    await until(
      () => snapshot(session),
      (s) =>
        s.attempts.filter((a: any) => a.state === "completed").length === 2,
    );
    await until(
      () => hub!.request("receipt", { id: first.id, requestId: secondLogical }),
      (r) => r.state === "completed",
    );
    record("node SIGKILL preserves the same running attempt and reconnects");
    hold();
    const pending = hub.request("prompt", {
      id: first.id,
      text: "Revoke at the commit boundary",
    });
    void pending.catch(() => {});
    await entered();
    writeFileSync(join(state, "hold-revocation"), "hold");
    const ending = hub.request("end", { id: first.id });
    void ending.catch(() => {});
    await until(() => existsSync(join(state, "revocation-committed")), Boolean);
    await kill(daemon);
    unlinkSync(join(state, "hold-revocation"));
    await bootDaemon();
    await ending;
    await stopped();
    const fenced = await hub.request("status", { id: first.id });
    assert(fenced.revoked && fenced.owned_execution_stopped);
    assert.equal((await snapshot(session)).attempts.length, 3);
    assert.equal(
      (await snapshot(session)).attempts.filter(
        (a: any) => a.state === "cancelled",
      ).length,
      1,
    );
    record(
      "daemon SIGKILL after revocation commit recovers lost acknowledgement and fences replacement",
    );
    const next = await hub.request("create"),
      nextRecord = await hub.request("record", { id: next.id });
    assert.notEqual(nextRecord.executionAuthority.sessionId, session);
    await hub.request("reassign", { principalId: cfg.otherPrincipalId });
    await assert.rejects(
      hub.request("renew", { id: next.id }),
      /authority|occupant|generation/i,
    );
    await stopped();
    await hub.request("reassign", { principalId: cfg.principalId });
    const station = await hub.request("station");
    assert(station.occupancyEpoch >= 3);
    const moved = await hub.request("create"),
      movedRecord = await hub.request("record", { id: moved.id });
    assert.equal(
      movedRecord.executionAuthority.binding.occupancy_epoch,
      station.occupancyEpoch,
    );
    assert.equal(
      (await snapshot(movedRecord.executionAuthority.sessionId)).messages
        .length,
      0,
    );
    record(
      "occupant A → B → A advances the generation and imports no prior session state",
    );
    await hub.request("suspend", { id: cfg.principalId });
    await assert.rejects(
      hub.request("renew", { id: moved.id }),
      /suspended|authority/i,
    );
    await stopped();
    await hub.request("unsuspend", { id: cfg.principalId });
    record(
      "principal suspension denies renewal and explicitly revokes execution",
    );
    const recovering = await hub.request("create"),
      recoveringRecord = await hub.request("record", { id: recovering.id }),
      recoveringSession = recoveringRecord.executionAuthority.sessionId;
    hold();
    const interruptedTurn = hub.request("prompt", {
      id: recovering.id,
      text: "Interrupt on daemon restart",
    });
    void interruptedTurn.catch(() => {});
    await entered();
    await kill(daemon);
    await bootDaemon();
    await hub.request("renew", { id: recovering.id });
    await until(
      () => hub!.request("status", { id: recovering.id }),
      (s) => s.authorized && s.interrupted_attempts.length === 1,
    );
    const interrupted = await snapshot(recoveringSession);
    assert.equal(interrupted.attempts.length, 1);
    assert.equal(interrupted.attempts[0].state, "interrupted");
    await hub.request("end", { id: recovering.id });
    await stopped();
    record(
      "daemon SIGKILL requires fresh authority and leaves one interrupted attempt without replay",
    );
    const preparedSession = await hub.request("create"),
      preparedRecord = await hub.request("record", { id: preparedSession.id }),
      preparedLocal = preparedRecord.executionAuthority.sessionId,
      preparedId = crypto.randomUUID();
    await hub.request("gate-start");
    hold();
    const preparing = hub.request("prompt", {
      id: preparedSession.id,
      text: "Recover before dispatch",
      requestId: preparedId,
    });
    void preparing.catch(() => {});
    await until(() => hub!.request("gate-held"), Boolean);
    assert.equal((await snapshot(preparedLocal)).attempts.length, 0);
    await kill(hub.p);
    hub = bootHub();
    assert.equal(await hub.started, cfg.port);
    await until(() => hub!.request("online"), Boolean);
    await entered();
    const preparedReceipt = await until(
      () =>
        hub!.request("receipt", {
          id: preparedSession.id,
          requestId: preparedId,
        }),
      (r) => r.state === "accepted",
    );
    assert.equal((await snapshot(preparedLocal)).attempts.length, 1);
    release();
    await until(
      () =>
        hub!.request("receipt", {
          id: preparedSession.id,
          requestId: preparedId,
        }),
      (r) => r.state === "completed",
    );
    assert.equal(
      (
        await hub.request("prompt", {
          id: preparedSession.id,
          text: "Recover before dispatch",
          requestId: preparedId,
        })
      ).attemptId,
      preparedReceipt.attemptId,
    );
    await hub.request("gate-clear");
    await hub.request("end", { id: preparedSession.id });
    await stopped();
    record(
      "Hub SIGKILL before dispatch commit recovers the prepared logical instruction exactly once",
    );
    const runId = "run_" + hex(),
      board = await hub.request("board-create", { runId, epoch: 7 });
    await hub.request("stale-run", { runId, epoch: 8 });
    await assert.rejects(
      hub.request("renew", {
        id: board.id,
        run: { source: "superpipeline", id: runId, epoch: 7 },
      }),
      /stale|authority/i,
    );
    await stopped();
    record("stale board run epoch is fenced before another model/tool grant");
    const adapter = await hub.request("create"),
      adapterRecord = await hub.request("record", { id: adapter.id }),
      adapterSession = adapterRecord.executionAuthority.sessionId;
    hold();
    const adapterRequest = randomUUID();
    await hub.request("prompt", {
      id: adapter.id,
      text: "Survive an adapter process crash",
      requestId: adapterRequest,
    });
    await entered();
    const ownedAdapters = execFileSync("/bin/ps", ["-Ao", "pid,ppid,args"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter(
        (m): m is RegExpExecArray =>
          !!m &&
          Number(m[2]) === nodeProcess!.pid &&
          m[3]!.includes(
            join(repo, "bin/salaam.mjs") + " acp --state " + state,
          ),
      );
    assert.equal(
      ownedAdapters.length,
      1,
      "Exactly one ACP adapter must belong to this test node",
    );
    process.kill(Number(ownedAdapters[0]![1]), "SIGKILL");
    await until(
      () => hub!.request("record", { id: adapter.id }),
      (r) => r.nodeSessionId !== adapterRecord.nodeSessionId,
    );
    release();
    const adapterReceipt = await until(
      () =>
        hub!.request("receipt", { id: adapter.id, requestId: adapterRequest }),
      (r) => r.state === "completed",
    );
    const adapterSnapshot = await snapshot(adapterSession);
    assert.equal(adapterSnapshot.attempts.length, 1);
    assert.equal(adapterSnapshot.attempts[0].id, adapterReceipt.attemptId);
    await hub.request("end", { id: adapter.id });
    await stopped();
    record(
      "adapter SIGKILL reattaches the same session and verified attempt without replay",
    );

    const cancelling = await hub.request("create"),
      cancelRecord = await hub.request("record", { id: cancelling.id }),
      cancelSession = cancelRecord.executionAuthority.sessionId,
      cancelPrompt = randomUUID();
    hold();
    await hub.request("prompt", {
      id: cancelling.id,
      text: "Cancel across a committed Hub intent crash",
      requestId: cancelPrompt,
    });
    await entered();
    await hub.request("cancel-gate-start");
    const cancelCall = hub.request("cancel", { id: cancelling.id });
    void cancelCall.catch(() => {});
    await until(() => hub!.request("cancel-gate-held"), Boolean);
    const intentEvents = await hub.request("events", { id: cancelling.id });
    const intent = intentEvents.find(
      (e: any) => e.payload?.cancellation?.targetRequestId === cancelPrompt,
    )?.payload.cancellation;
    assert(intent?.requestId && intent.state === "requested");
    await kill(hub.p);
    hub = bootHub();
    await hub.started;
    await until(() => hub!.request("online"), Boolean);
    await until(
      () => hub!.request("events", { id: cancelling.id }),
      (events) =>
        events.some(
          (e: any) =>
            e.payload?.cancellation?.requestId === intent.requestId &&
            e.payload.cancellation.state === "confirmed",
        ),
    );
    const cancelled = await snapshot(cancelSession);
    assert.equal(cancelled.attempts.length, 1);
    assert.equal(cancelled.attempts[0].state, "cancelled");
    const cancelReceipt = await hub.request("receipt", {
      id: cancelling.id,
      requestId: cancelPrompt,
    });
    assert.equal(cancelReceipt.state, "interrupted");
    assert.equal(cancelReceipt.attemptId, cancelled.attempts[0].id);
    await hub.request("end", { id: cancelling.id });
    await stopped();
    record(
      "Hub SIGKILL after durable cancellation intent recovers the same target and confirms actual stop",
    );

    const expiring = await hub.request("create"),
      expiresRecord = await hub.request("record", { id: expiring.id }),
      expiresSession = expiresRecord.executionAuthority.sessionId;
    hold();
    const expiryTurn = hub.request("prompt", {
      id: expiring.id,
      text: "Lose the Hub without a stop message",
    });
    void expiryTurn.catch(() => {});
    await entered();
    await kill(hub.p);
    await until(
      () => snapshot(expiresSession),
      (s) => s.state === "exited" || s.state === "unhealthy",
      110000,
    );
    const expired = await snapshot(expiresSession);
    assert(expired.attempts.every((a: any) => a.state === "cancelled"));
    assert.equal(expired.attempts.length, 1);
    hub = bootHub();
    await hub.started;
    // gateway/client.go caps backoff at 30s plus up to 15s jitter after a long
    // outage. Observe registration rather than assuming a reconnect inside 30s.
    await until(() => hub!.request("online"), Boolean, 60000);
    await stopped();
    assert((await hub.request("status", { id: expiring.id })).revoked);
    record(
      "real authority lease expiry after Hub loss stops work without a delivered revocation",
    );
  }
  const evidence = {
    passed: true,
    recorded_at: new Date().toISOString(),
    sources: {
      salaam: sourceEvidence(repo),
      agentpod: sourceEvidence(resolve(hubDirectory, "../..")),
    },
    runtimes: {
      bun: Bun.version,
      node: execFileSync(node, ["--version"], { encoding: "utf8" }).trim(),
    },
    cases,
    provider: "pinned Pi offline proof provider",
    station_mode: stationMode,
    station_runtime: stationMode
      ? {
          image_digest: process.env.SALAAM_STATION_RUNTIME_IMAGE,
          profile: "linux-systemd-station-v1",
          files: 50001,
        }
      : undefined,
    scope: mcpMode
      ? "real authenticated local gateway, Go node, persisted proxy, daemon and pinned Pi; synthetic signed Accounts and MCP product data/effects; no live Library/provider acceptance"
      : "real authenticated local gateway, real Go node and daemon; synthetic Accounts and board ownership",
    fixture_sha256: createHash("sha256")
      .update(JSON.stringify(checked))
      .digest("hex"),
    acp_fixture_sha256: createHash("sha256").update(acpCorpus).digest("hex"),
  };
  if (process.env.SALAAM_EVIDENCE)
    writeFileSync(
      process.env.SALAAM_EVIDENCE,
      JSON.stringify(evidence, null, 2) + "\n",
      { mode: 0o600 },
    );
  console.log(JSON.stringify(evidence, null, 2));
  acceptancePassed = true;
} catch (error) {
  console.error("Salaam end-to-end proof failed:", (error as Error).message);
  if (stationMode && existsSync(join(state, "journal.sqlite"))) {
    for (const query of [
      "SELECT id,state,error FROM sessions",
      "SELECT id,session_id,state,kind,helper_pid,helper_identity,helper_state,helper_stop_json FROM station_calls",
      "SELECT id,call_id,state,unit_json,stop_json FROM station_units",
    ]) {
      try {
        console.error(
          "Station failure metadata:",
          JSON.stringify(stationRows(query)),
        );
      } catch {
        // Preserve the original failure if the diagnostic journal is unavailable.
      }
    }
  }
  if (existsSync(join(state, "host.log")))
    logs.push(readFileSync(join(state, "host.log"), "utf8").slice(-24000));
  console.error(logs.slice(-20).join("\n"));
  throw error;
} finally {
  if (hub?.p.exitCode === null) await hub.request("cleanup").catch(() => {});
  await kill(nodeProcess);
  await kill(hub?.p);
  await kill(daemon);
  if (runtimeMode && existsSync(join(state, "host/status.json"))) {
    const own = JSON.parse(
      readFileSync(join(state, "host/status.json"), "utf8"),
    );
    try {
      process.kill(own.supervisor_pid, "SIGTERM");
    } catch {}
    await until(
      () => {
        try {
          process.kill(own.daemon_pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      Boolean,
      15000,
    ).catch(() => {});
  }
  if (!acceptancePassed && process.env.SALAAM_KEEP_FAILED === "1")
    console.error("Retained failed isolated fixture: " + dir);
  else rmSync(dir, { recursive: true, force: true });
}
