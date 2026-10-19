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
const hex = () => randomUUID().replaceAll("-", "").slice(0, 20);
const cfg = {
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
  const sha = createHash("sha256").update(
    execFileSync("git", ["diff", "HEAD", "--binary"], { cwd }),
  );
  for (const file of execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort())
    sha.update(file + "\0").update(readFileSync(join(cwd, file)));
  return {
    base_commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim(),
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
const runtimeMode = process.env.SALAAM_RUNTIME_REHEARSAL === "1";
const manifestPath = join(dir, "host.json");
const cases: string[] = [];
const record = (name: string) => {
  cases.push(name);
  console.log("PASS " + name);
};
const logs: string[] = [];
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
try {
  if (!runtimeMode) await bootDaemon();
  else {
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
  if (runtimeMode) await runtimeCases();
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
    await until(() => hub!.request("online"), Boolean);
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
    scope:
      "real authenticated local gateway, real Go node and daemon; synthetic Accounts and board ownership",
    fixture_sha256: createHash("sha256")
      .update(JSON.stringify(checked))
      .digest("hex"),
  };
  if (process.env.SALAAM_EVIDENCE)
    writeFileSync(
      process.env.SALAAM_EVIDENCE,
      JSON.stringify(evidence, null, 2) + "\n",
      { mode: 0o600 },
    );
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  console.error("Salaam end-to-end proof failed:", (error as Error).message);
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
  rmSync(dir, { recursive: true, force: true });
}
