/** Explicit integration probe: real hub DB/routes/broker → real Go handler →
 * authenticated HTTP download → temporary filesystem → node verification and
 * rollback. This does not start or claim native harness activation.
 *
 * DATABASE_URL=postgres://agentpod:agentpod-dev-password@127.0.0.1:5434/agentpod \
 *   bun tests/integration/skills-node-e2e.ts
 * Needs the isolated pgvector test DB and the node's Go toolchain.
 */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { db, rawSql, closeDatabase } from "../../src/db/drizzle";
import { stations } from "../../src/db/schema/stations";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import { createPrincipal } from "../../src/services/principals";
import { setGrant } from "../../src/services/grants";
import { connectionManager } from "../../src/services/connection-manager";
import * as broker from "../../src/services/broker";
import {
  createSkillManagementRoutes,
  skillArtifactDownloadRoutes,
} from "../../src/routes/skill-management";
import { SkillHubOperation, SkillVerifyResult, type PluginOperationPlan } from "@agentpod/contract";

const database = new URL(process.env.DATABASE_URL ?? "http://missing");
assert(
  ["127.0.0.1", "localhost"].includes(database.hostname) &&
    database.port === "5434" &&
    database.pathname === "/agentpod",
  "Use the isolated test database on loopback port 5434",
);
const temporary = mkdtempSync(join(tmpdir(), "sjl-skills-hub-e2e-")),
  workspacePath = join(temporary, "workspace"),
  profilePath = join(temporary, "hermes-profile"),
  binary = join(temporary, "node-fixture");
mkdirSync(workspacePath);
mkdirSync(profilePath);
const hermesConfig = "model: fixture\nplatforms:\n  - matrix\n";
writeFileSync(join(profilePath, "config.yaml"), hermesConfig);
const workspace = realpathSync(workspacePath);
const profile = realpathSync(profilePath);
const nodeDirectory = resolve(import.meta.dir, "../../../node-agent");
const build = Bun.spawn(
  ["go", "test", "-c", "-o", binary, "./internal/gateway"],
  { cwd: nodeDirectory, stdout: "pipe", stderr: "pipe" },
);
const buildOutput = Promise.all([
  new Response(build.stdout).text(),
  new Response(build.stderr).text(),
]);
try {
  assert.equal(await build.exited, 0, (await buildOutput).join("\n"));
} catch (error) {
  rmSync(temporary, { recursive: true, force: true });
  await closeDatabase();
  throw error;
}
const userId = `test-skill-e2e-${crypto.randomUUID()}`;
const previousControlPair = process.env.ENFORCE_CONTROL_PAIR;
const principalIds: string[] = [];
let nodeId: string | undefined,
  server: ReturnType<typeof Bun.serve> | undefined,
  child: ReturnType<typeof Bun.spawn> | undefined;
try {
  await ensurePgMigrations();
  await createTestUser({ id: userId });
  const { token } = await mintEnrollmentToken(userId);
  const enrolled = await enrollNode(token, {
    hostname: "skill-fixture",
    os: "linux",
    arch: "arm64",
    cpuCount: 1,
  });
  nodeId = enrolled.nodeId;
  const humanPrincipal = await createPrincipal({
    kind: "human",
    handle: `skill-human-${crypto.randomUUID()}`,
    userId,
  });
  principalIds.push(humanPrincipal);
  const agentPrincipal = await createPrincipal({
    kind: "agent",
    handle: `skill-agent-${crypto.randomUUID()}`,
  });
  principalIds.push(agentPrincipal);
  const [station] = await db
    .insert(stations)
    .values({
      id: `station_${crypto.randomUUID()}`,
      tenantId: BOOTSTRAP_TENANT_ID,
      userId,
      principalId: agentPrincipal,
      nodeId,
      harness: "codex",
      stationKey: "codex:fixture",
      kind: "leaf",
      displayName: "Synthetic skill integration",
      workspacePath: workspace,
      capabilities: ["skills.manage"],
    })
    .returning();
  const app = new Hono()
    .route("/api", skillArtifactDownloadRoutes)
    .use("*", async (c, next) => {
      c.set("user", {
        id: userId,
        tenantId: BOOTSTRAP_TENANT_ID,
        authType: "api_key",
      });
      await next();
    })
    .route("/api", createSkillManagementRoutes());
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const origin = `http://127.0.0.1:${server.port}`;
  const nodeProcess = Bun.spawn([binary, "-test.run=^TestSkillHubFixture$"], {
    cwd: nodeDirectory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...globalThis.process.env,
      SJL_SKILL_HUB_FIXTURE: "1",
      SJL_SKILL_FIXTURE_NODE: nodeId,
      SJL_SKILL_FIXTURE_SECRET: enrolled.nodeSecret,
      SJL_SKILL_FIXTURE_HUB: origin,
      SJL_SKILL_FIXTURE_WORKSPACE: workspace,
      SJL_SKILL_FIXTURE_PROFILE: profile,
    },
  });
  child = nodeProcess;
  const stderr = new Response(nodeProcess.stderr).text();
  const output = (async () => {
    const reader = nodeProcess.stdout.getReader(),
      decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.startsWith("{"))
            broker.handleNodeMessage(nodeId!, JSON.parse(line));
          else if (line && line !== "PASS")
            throw new Error(`Unexpected fixture output: ${line}`);
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  // Fail pending broker calls immediately if the fixture protocol breaks.
  // Keep the original promise to assert its error after process cleanup.
  void output.catch(() => broker.dropNode(nodeId!));
  connectionManager.register(nodeId, (msg) => {
    if (msg.type !== "req") return;
    nodeProcess.stdin.write(JSON.stringify(msg) + "\n");
    void Promise.resolve(nodeProcess.stdin.flush()).catch(() =>
      broker.dropNode(nodeId!),
    );
  });
  async function request(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) {
    const result = await fetch(origin + path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await result.json();
    assert.equal(result.status, 200, JSON.stringify(data));
    return data;
  }
  const archive = readFileSync(
    join(nodeDirectory, "internal/skills/testdata/export-codex.tar.gz"),
  );
  const uploaded = await fetch(
    origin + "/api/skills/artifacts?harness=codex&profile=fixture",
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: archive,
    },
  );
  assert.equal(uploaded.status, 201);
  const artifact = (await uploaded.json()) as { id: string };
  const prefix = `/api/stations/${station!.id}/skills`;
  process.env.ENFORCE_CONTROL_PAIR = "true";
  const denied = await fetch(origin + prefix + "/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      artifactId: artifact.id,
    }),
  });
  assert.equal(denied.status, 403, "Installation requires the station grant");
  await denied.arrayBuffer();
  await setGrant(humanPrincipal, {
    mayDispatch: [agentPrincipal],
    mayGrantReach: true,
  });
  const plan = SkillHubOperation.parse(
    await request(prefix + "/plan", {
      requestId: crypto.randomUUID(),
      artifactId: artifact.id,
    }),
  );
  assert.equal(plan.state, "planned");
  assert.equal(plan.plan!.binding.workspacePath, workspace);
  const applied = SkillHubOperation.parse(
    await request(`${prefix}/operations/${plan.id}/apply`, {
      planDigest: plan.plan!.planDigest,
    }),
  );
  assert.equal(applied.state, "applied");
  const verified = SkillVerifyResult.parse(
    await request(prefix + "/verify", { profile: "fixture" }),
  );
  assert.equal(verified.verification.present.value, true);
  assert.equal(verified.verification.loaded.value, null);
  const installed = join(
    verified.verification.path!,
    "skills/sjl-fixture/SKILL.md",
  );
  assert(readFileSync(installed, "utf8").includes("sjl-fixture"));
  const replay = SkillHubOperation.parse(
    await request(`${prefix}/operations/${plan.id}/apply`, {
      planDigest: plan.plan!.planDigest,
    }),
  );
  assert.equal(replay.receipt!.completedAt, applied.receipt!.completedAt);
  const rollback = SkillHubOperation.parse(
    await request(prefix + "/rollback", {
      requestId: crypto.randomUUID(),
      profile: "fixture",
    }),
  );
  const reverted = SkillHubOperation.parse(
    await request(`${prefix}/operations/${rollback.id}/apply`, {
      planDigest: rollback.plan!.planDigest,
    }),
  );
  assert.equal(reverted.state, "applied");
  const absent = SkillVerifyResult.parse(
    await request(prefix + "/verify", { profile: "fixture" }),
  );
  assert.equal(absent.verification.present.value, false);
  assert.equal(absent.verification.current, null);
  assert(
    readFileSync(installed).length > 0,
    "Rollback must retain the previous generation",
  );

  // Plugin management: the same hub machinery, a Hermes station, and the real
  // Go installer writing a fixture profile.
  const hermesPrincipal = await createPrincipal({
    kind: "agent",
    handle: `plugin-agent-${crypto.randomUUID()}`,
  });
  principalIds.push(hermesPrincipal);
  const [hermes] = await db
    .insert(stations)
    .values({
      id: `station_${crypto.randomUUID()}`,
      tenantId: BOOTSTRAP_TENANT_ID,
      userId,
      principalId: hermesPrincipal,
      nodeId,
      harness: "hermes",
      stationKey: "hermes:fixture",
      kind: "leaf",
      displayName: "Synthetic plugin integration",
      workspacePath: profile,
      capabilities: ["plugins.manage"],
    })
    .returning();
  const plugins = `/api/stations/${hermes!.id}/plugins`;
  const pluginDenied = await fetch(origin + plugins + "/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID(), action: "enable" }),
  });
  assert.equal(pluginDenied.status, 403, "Plugin changes require the station grant");
  await pluginDenied.arrayBuffer();
  await setGrant(humanPrincipal, {
    mayDispatch: [agentPrincipal, hermesPrincipal],
    mayGrantReach: true,
  });
  const pluginDirectory = join(profile, "plugins", "agentpod-live");
  const enable = SkillHubOperation.parse(
    await request(plugins + "/plan", { requestId: crypto.randomUUID(), action: "enable" }),
  );
  assert.equal(enable.state, "planned", enable.error ?? "");
  assert(!existsSync(pluginDirectory), "Planning must not write the plugin");
  const enablePlan = enable.plan as PluginOperationPlan;
  assert.equal(enablePlan.fileAction, "add");
  assert(enablePlan.config!.diff.includes("- agentpod-live"));
  const enabled = SkillHubOperation.parse(
    await request(`${plugins}/operations/${enable.id}/apply`, { planDigest: enablePlan.planDigest }),
  );
  assert.equal(enabled.state, "applied", enabled.error ?? "");
  assert(existsSync(join(pluginDirectory, "plugin.yaml")));
  assert(readFileSync(join(profile, "config.yaml"), "utf8").includes("- agentpod-live"));
  const disable = SkillHubOperation.parse(
    await request(plugins + "/plan", { requestId: crypto.randomUUID(), action: "disable" }),
  );
  const disabled = SkillHubOperation.parse(
    await request(`${plugins}/operations/${disable.id}/apply`, { planDigest: disable.plan!.planDigest }),
  );
  assert.equal(disabled.state, "applied", disabled.error ?? "");
  assert(!existsSync(pluginDirectory));
  assert.equal(readFileSync(join(profile, "config.yaml"), "utf8"), hermesConfig);
  const refused = SkillHubOperation.parse(
    await request(plugins + "/plan", { requestId: crypto.randomUUID(), action: "disable" }),
  );
  assert.equal(refused.state, "conflict");
  assert.match(refused.error ?? "", /no record of installing/);

  nodeProcess.stdin.end();
  assert.equal(await nodeProcess.exited, 0, await stderr);
  await output;
  console.log(
    "PASS: real hub/Go scoped authorization, plan, authenticated download, reviewed apply, disk verification, replay and rollback; plugin enable, disable and refusal; native loading remains unknown.",
  );
} finally {
  if (nodeId) {
    connectionManager.unregister(nodeId);
    broker.dropNode(nodeId);
  }
  if (child && child.exitCode === null) {
    child.kill();
    await child.exited;
  }
  server?.stop(true);
  if (previousControlPair === undefined)
    delete process.env.ENFORCE_CONTROL_PAIR;
  else process.env.ENFORCE_CONTROL_PAIR = previousControlPair;
  if (nodeId) await rawSql`DELETE FROM nodes WHERE id=${nodeId}`;
  await rawSql`DELETE FROM station_audit WHERE user_id=${userId}`;
  for (const principalId of principalIds)
    await rawSql`DELETE FROM principals WHERE id=${principalId}`;
  await rawSql`DELETE FROM "user" WHERE id=${userId}`;
  rmSync(temporary, { recursive: true, force: true });
  await closeDatabase();
}
