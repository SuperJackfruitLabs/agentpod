// Contract: the plugin, loaded by a real OpenClaw, reports a failed turn.
//
//   OPENCLAW_BIN=openclaw node contract/run-in-openclaw.mjs
//
// Needs an installed `openclaw` (CI installs the fleet version and npm's latest).
// Everything else is local and fake: a provider that answers with Kimi's real
// 403 and opencode-go's real 400, and a stand-in for the AgentPod node's
// intake socket. The turn is driven over ACP exactly as the node drives it
// (`openclaw acp --no-prefix-cwd --session agent:krishna:main`), so this is the
// production path, not a unit of it.
//
// It asserts three things:
//   1. OpenClaw loads the plugin and does not block its agent_end hook.
//   2. One report reaches the socket, keyed by the ACP session's key, leading
//      with the first model's words and listing every attempt.
//   3. How OpenClaw ended the ACP prompt — recorded, not asserted, so the day
//      OpenClaw starts reporting errors over ACP itself shows up in the log.

import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLAW = process.env.OPENCLAW_BIN || "openclaw";
const SESSION_KEY = "agent:krishna:main";

const KIMI_403 = {
  type: "error",
  error: {
    type: "permission_error",
    message:
      "You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota",
  },
};
const OPENCODE_400 = {
  type: "error",
  error: {
    type: "MissingSessionID",
    message: "Request is missing x-opencode-session and cannot be routed efficiently. Please see https://opencode.ai/docs/go/#where-can-i-use-it",
  },
};

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const listen = (server, ...args) => new Promise((resolve) => server.listen(...args, () => resolve(server)));

async function main() {
  const version = execFileSync(OPENCLAW, ["--version"], { encoding: "utf8" }).trim();
  console.log(`OpenClaw ${version}`);

  // A home of its own, so nothing on the machine running this leaks in.
  const home = fs.mkdtempSync(path.join(os.platform() === "darwin" ? "/tmp" : os.tmpdir(), "ocx-"));
  const env = { ...process.env, HOME: home, AGENTPOD_TURN_ERROR_SOCKET: "" };

  const provider = await listen(
    http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const [status, body] = req.url.startsWith("/anth") ? [403, KIMI_403] : [400, OPENCODE_400];
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    }),
    0,
    "127.0.0.1"
  );
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;

  // The node's intake, as far as a plugin can tell: one line in, "ok" back.
  fs.mkdirSync(path.join(home, ".agentpod"), { mode: 0o700 });
  const reports = [];
  const intake = await listen(
    net.createServer((c) => {
      let buf = "";
      c.on("data", (d) => {
        buf += d;
        if (buf.includes("\n")) {
          reports.push(JSON.parse(buf.split("\n")[0]));
          c.end("ok\n");
        }
      });
    }),
    path.join(home, ".agentpod", "turn-errors.sock")
  );

  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const model = (id) => ({
    id, name: id, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
  });
  fs.mkdirSync(path.join(home, ".openclaw"));
  fs.mkdirSync(path.join(home, "ws"));
  fs.writeFileSync(path.join(home, "token"), "contract-token");
  fs.writeFileSync(
    path.join(home, ".openclaw", "openclaw.json"),
    JSON.stringify({
      models: {
        mode: "merge",
        providers: {
          fakeq: { baseUrl: `${providerUrl}/anth`, api: "anthropic-messages", apiKey: "x", models: [model("quota")] },
          fakeb: { baseUrl: `${providerUrl}/oai/v1`, api: "openai-completions", apiKey: "x", models: [model("bad")] },
        },
      },
      agents: {
        defaults: { model: { primary: "fakeq/quota", fallbacks: ["fakeb/bad"] }, workspace: path.join(home, "ws") },
        list: [{ id: "krishna", default: true, workspace: path.join(home, "ws") }],
      },
      gateway: { port, mode: "local", bind: "loopback", auth: { mode: "token", token: "contract-token" } },
      // What `apn openclaw-errors` writes: the plugin's directory, enabled, and
      // allowed agent_end — which OpenClaw blocks for non-bundled plugins.
      plugins: {
        load: { paths: [PLUGIN_DIR] },
        entries: { "agentpod-errors": { enabled: true, hooks: { allowConversationAccess: true } } },
      },
    })
  );

  const gatewayLog = path.join(home, "gateway.log");
  const gateway = spawn(OPENCLAW, ["gateway", "--port", String(port)], {
    env,
    stdio: ["ignore", fs.openSync(gatewayLog, "w"), fs.openSync(gatewayLog, "a")],
  });

  let acp;
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      up = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${port}/`, (r) => { r.resume(); resolve(true); }).on("error", () => resolve(false));
      });
      if (!up) await sleep(1000);
    }
    check(up, "the gateway came up");
    if (!up) return;

    const log = fs.readFileSync(gatewayLog, "utf8");
    check(!/blocked because[^\n]*agentpod-errors/.test(log), "OpenClaw did not block the plugin's agent_end hook");

    // The ACP SDK OpenClaw itself ships, so client and bridge agree on it.
    const openclawPkg = fs.realpathSync(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "openclaw"));
    const sdkPath = createRequire(path.join(openclawPkg, "package.json")).resolve("@agentclientprotocol/sdk");
    const sdk = await import(pathToFileURL(sdkPath).href);

    acp = spawn(OPENCLAW, ["acp", "--no-prefix-cwd", "--token-file", path.join(home, "token"), "--url", `ws://127.0.0.1:${port}`, "--session", SESSION_KEY], {
      cwd: path.join(home, "ws"),
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const conn = new sdk.ClientSideConnection(
      () => ({ sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) }),
      sdk.ndJsonStream(Writable.toWeb(acp.stdin), Readable.toWeb(acp.stdout))
    );
    await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await conn.newSession({ cwd: path.join(home, "ws"), mcpServers: [] });
    try {
      const r = await conn.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "Are you here?" }] });
      console.log(`NOTE  ACP prompt resolved ${JSON.stringify(r)} — the error did not travel over ACP`);
    } catch (e) {
      console.log(`NOTE  ACP prompt rejected: ${e.message} — OpenClaw now reports errors over ACP itself`);
    }

    for (let i = 0; i < 50 && reports.length === 0; i++) await sleep(100);
    await sleep(1500); // a second report would land here

    check(reports.length === 1, `exactly one report reached the node (got ${reports.length})`);
    const [report] = reports;
    if (report) {
      check(report.harnessSessionKey === SESSION_KEY, `keyed by the ACP session's key (${report.harnessSessionKey})`);
      check(/weekly \(7-day\) usage limit/.test(report.error?.message ?? ""), "leads with the first model's words, unwrapped from its JSON body");
      check(report.error?.provider === "fakeq" && report.error?.model === "quota", "names the first model");
      check(
        JSON.stringify((report.error?.attempts ?? []).map((a) => a.provider)) === JSON.stringify(["fakeq", "fakeb"]),
        "lists every attempt, in order"
      );
      check(/x-opencode-session/.test(report.error?.attempts?.[1]?.message ?? ""), "keeps the fallback's words too");
    }
  } finally {
    const exited = (p) => (p && p.exitCode === null ? new Promise((r) => { p.once("exit", r); setTimeout(r, 5000); }) : null);
    acp?.kill();
    gateway.kill();
    await Promise.all([exited(acp), exited(gateway)]);
    provider.close();
    intake.close();
    if (failures.length > 0) {
      console.log("\n--- gateway log (tail) ---");
      console.log(fs.readFileSync(gatewayLog, "utf8").split("\n").slice(-40).join("\n"));
    }
    // Cleanup is not part of the contract; a gateway still flushing its state
    // must not turn a passing run red.
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      console.log(`NOTE  left ${home} behind: ${err.message}`);
    }
  }
}

await main().catch((err) => {
  console.log(`FAIL  ${err?.stack ?? err}`);
  failures.push(String(err));
});
console.log(failures.length === 0 ? "\ncontract holds" : `\n${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
