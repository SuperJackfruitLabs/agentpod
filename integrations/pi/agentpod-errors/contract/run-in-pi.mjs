// Contract: the extension, loaded by a real Pi under pi-acp, reports a failed turn.
//
//   node contract/run-in-pi.mjs      (needs `pi` and `pi-acp` installed globally)
//
// Everything else is local and fake: a provider that answers with Kimi's real
// 403 (one model) or an Anthropic 529 (another, which Pi retries), and a
// stand-in for the AgentPod node's intake socket. Each turn is driven over ACP
// through pi-acp with AGENTPOD_ACP_SESSION set, exactly as the node spawns it.
//
// Asserts: Pi loads the extension; one report per failed turn reaches the
// socket, keyed by the hub session; it leads with the sentence, carries the
// status and the provider's type; Pi's own retries arrive as attempts of one
// report, not as several reports. How pi-acp ended the ACP prompt is recorded,
// not asserted, so the day it starts reporting errors itself shows up here.

import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION = "acps_contract";

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server, ...args) => new Promise((resolve) => server.listen(...args, () => resolve(server)));

async function main() {
  const piVersion = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const piAcpPkg = fs.realpathSync(path.join(globalRoot, "pi-acp"));
  const piAcpVersion = JSON.parse(fs.readFileSync(path.join(piAcpPkg, "package.json"), "utf8")).version;
  console.log(`Pi ${piVersion}, pi-acp ${piAcpVersion}`);

  const home = fs.mkdtempSync(path.join(os.platform() === "darwin" ? "/tmp" : os.tmpdir(), "pix-"));
  const env = { ...process.env, HOME: home, AGENTPOD_ACP_SESSION: SESSION, AGENTPOD_TURN_ERROR_SOCKET: "" };

  const provider = await listen(
    http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let model = "";
        try {
          model = JSON.parse(body).model;
        } catch {}
        if (model === "flaky") {
          res.writeHead(529, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
          return;
        }
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "permission_error", message: "You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends." } }));
      });
    }),
    0,
    "127.0.0.1"
  );

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

  // What `apn pi-errors enable` writes: the extension in Pi's global dir.
  // One top-level file, so pi-acp's session banner lists it (the banner shows
  // top-level files only; a subdirectory extension loads but goes unlisted).
  const extDir = path.join(home, ".pi", "agent", "extensions");
  fs.mkdirSync(extDir, { recursive: true });
  fs.copyFileSync(path.join(EXT_DIR, "index.ts"), path.join(extDir, "agentpod-errors.ts"));
  const model = (id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "models.json"),
    JSON.stringify({ providers: { fakeq: { baseUrl: `http://127.0.0.1:${provider.address().port}`, api: "anthropic-messages", apiKey: "x", models: [model("quota"), model("flaky")] } } })
  );
  fs.mkdirSync(path.join(home, "ws"));

  const sdkPath = createRequire(path.join(piAcpPkg, "package.json")).resolve("@agentclientprotocol/sdk");
  const sdk = await import(pathToFileURL(sdkPath).href);

  // One ACP turn through pi-acp with the given default model.
  async function turn(defaultModel) {
    fs.writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ defaultProvider: "fakeq", defaultModel, retry: { enabled: true, maxRetries: 2, baseDelayMs: 200 } })
    );
    const acp = spawn("pi-acp", [], { cwd: path.join(home, "ws"), env, stdio: ["pipe", "pipe", "inherit"] });
    let banner = "";
    const conn = new sdk.ClientSideConnection(
      () => ({
        sessionUpdate: async (p) => {
          if (p.update?.sessionUpdate === "agent_message_chunk") banner += p.update.content?.text ?? "";
        },
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      }),
      sdk.ndJsonStream(Writable.toWeb(acp.stdin), Readable.toWeb(acp.stdout))
    );
    try {
      await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
      const s = await conn.newSession({ cwd: path.join(home, "ws"), mcpServers: [] });
      try {
        const r = await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "Are you here?" }] });
        console.log(`NOTE  ${defaultModel}: ACP prompt resolved ${JSON.stringify(r)} — the error did not travel over ACP`);
      } catch (e) {
        console.log(`NOTE  ${defaultModel}: ACP prompt rejected: ${e.message} — pi-acp now reports errors over ACP itself`);
      }
      await sleep(1500); // a report sent at agent_settled lands here
      return banner;
    } finally {
      acp.kill();
      await new Promise((r) => (acp.exitCode !== null ? r() : (acp.once("exit", r), setTimeout(r, 3000))));
    }
  }

  try {
    const banner = await turn("quota");
    check(banner.includes("agentpod-errors.ts"), "pi-acp lists the extension in the session banner, so a reader can see it is there");
    check(reports.length === 1, `one report for the quota turn (got ${reports.length})`);
    const q = reports[0];
    if (q) {
      check(q.acpSessionId === SESSION, `keyed by the hub session the node set (${q.acpSessionId})`);
      check((q.error?.message ?? "").startsWith("You've reached your weekly (7-day) usage limit"), "leads with the sentence, with no status or JSON around it");
      check(q.error?.httpStatus === 403, "carries the HTTP status");
      check(q.error?.providerErrorType === "permission_error", "carries the provider's own error type");
      check(q.error?.provider === "fakeq" && q.error?.model === "quota", "names the model");
    }

    await turn("flaky");
    check(reports.length === 2, `one report for the retried turn (got ${reports.length - 1})`);
    const f = reports[1];
    if (f) {
      check((f.error?.attempts ?? []).length === 3, `Pi's two retries are attempts of that one report (got ${(f.error?.attempts ?? []).length})`);
      check(f.error?.httpStatus === 529 && f.error?.providerErrorType === "overloaded_error", "the retried failure carries its status and type");
    }
  } finally {
    provider.close();
    intake.close();
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
