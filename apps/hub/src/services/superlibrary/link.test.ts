import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as realBroker from "../broker";
import { linkArtifact, MAX_CONCURRENT_LINKS, type LinkDeps, type LinkInput } from "./link";

const STATION = { id: "stn_1", stationKey: "builder", nodeId: "node_1", nodeStatus: "online", tenantId: "tnt_1" };
const AGENT = { principal: "prn_000000000000000000a2", kind: "agent" as const };
const FILE = new Uint8Array(2_500_000).map((_, i) => i % 251);
const BOARD = "brd_00000000000000b1";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

type Sent = { method: string; path: string; json?: any; body?: Uint8Array };
type Walked = { files: Array<{ path: string; size: number }>; tooMany?: boolean; tooLarge?: boolean };

/**
 * A fake node that answers exactly as the A4/A5 node does (`{ok, data, error}`, the real broker's
 * shape), and a fake Superlibrary that answers exactly as its upload routes do.
 */
function deps(
  o: { echoOffset?: boolean; walk?: Walked | { error: string }; tree?: Record<string, Uint8Array>; growBy?: number; readError?: string; sizeAt?: (offset: number, size: number) => number; extra?: Record<string, unknown> } = {},
) {
  const sent: Sent[] = [];
  const verbs: Array<{ verb: string; params: any }> = [];
  const tree = o.tree ?? { "out/data.bin": FILE };
  const d: LinkDeps = {
    broker: {
      async request(_n, verb, p: any) {
        verbs.push({ verb, params: p });
        if (verb === "fs.walk") {
          if (o.walk && "error" in o.walk) return { ok: false, error: o.walk.error };
          const w = o.walk ?? { files: [{ path: "", size: tree[p.path]!.length }] };
          return { ok: true, data: { root: p.path, files: w.files, skipped: [{ path: "locked.txt", reason: "unreadable" }], tooMany: w.tooMany ?? false, tooLarge: w.tooLarge ?? false, ...o.extra } };
        }
        if (verb === "fs.read") {
          if (o.readError) return { ok: false, error: o.readError };
          const whole = tree[p.path];
          if (!whole) return { ok: false, error: `${p.path}: not found` };
          const file = o.growBy ? new Uint8Array(whole.length + o.growBy) : whole;
          if (o.echoOffset === false) {
            // An old node: no offset param understood, reads from 0, echoes nothing.
            const chunk = file.subarray(0, p.maxBytes);
            return { ok: true, data: { content: Buffer.from(chunk).toString("base64"), encoding: "base64", truncated: chunk.length < file.length } };
          }
          const chunk = file.subarray(p.offset, p.offset + p.maxBytes);
          const eof = p.offset + chunk.length >= file.length;
          return { ok: true, data: { content: Buffer.from(chunk).toString("base64"), encoding: "base64", truncated: !eof, offset: p.offset, size: o.sizeAt ? o.sizeAt(p.offset, file.length) : file.length, eof } };
        }
        return { ok: false, error: `descriptor: unknown verb "${verb}"` };
      },
    },
    client: {
      asService: () => ({
        async request(method, path, init = {}) {
          sent.push({ method, path, json: init.json, body: init.body });
          if (path === "/api/v1/uploads") return Response.json({ uploadId: "upl_0000000000000001" }, { status: 201 });
          if (path.endsWith("/commit")) return Response.json({ itemId: "itm_0000000000000001", version: 1, url: "https://app.superlibrary.dev/a/itm_0000000000000001", sha256: "x", mediaType: "application/octet-stream", bytes: FILE.length }, { status: 201 });
          return new Response(null, { status: 204 });
        },
      }),
      asAgent: () => { throw new Error("not used"); },
      invalidateRoster: async () => {},
    },
    provenance: async () => ({ board: BOARD, card: "card_00000000000000c1", run: "run_00000000000000d1" }),
  };
  return { d, sent, verbs };
}

const link = (d: LinkDeps, over: Partial<LinkInput> = {}) => linkArtifact(d, { station: STATION, path: "out/data.bin", actor: AGENT, ...over });

test("a file larger than one read arrives whole, with its hash and its provenance", async () => {
  const { d, sent, verbs } = deps();
  const r = await link(d);
  expect(r).toMatchObject({ ok: true, itemId: "itm_0000000000000001", version: 1 });
  const reads = verbs.filter((v) => v.verb === "fs.read");
  expect(reads.length).toBe(3);
  expect(reads.map((v) => v.params.offset)).toEqual([0, 1 << 20, 2 << 20]);
  expect(reads.every((v) => v.params.key === "builder" && v.params.path === "out/data.bin")).toBe(true);
  const declare = sent.find((s) => s.path === "/api/v1/uploads")!;
  expect(declare.json).toEqual({
    title: "data.bin",
    scope: `board:${BOARD}`,
    files: [{ path: "data.bin", bytes: FILE.length, sha256: sha(FILE) }],
    // LinkSource is strict on the server: exactly these keys.
    source: { station: "stn_1", stationName: "builder", path: "out/data.bin", board: BOARD, card: "card_00000000000000c1", run: "run_00000000000000d1" },
  });
  const put = sent.find((s) => s.path.includes("/files?path="))!;
  expect(put.method).toBe("PUT");
  expect(put.path).toBe("/api/v1/uploads/upl_0000000000000001/files?path=data.bin");
  expect(Buffer.from(put.body!).equals(Buffer.from(FILE))).toBe(true);
  expect(sent.map((s) => `${s.method} ${s.path.split("?")[0]}`)).toEqual([
    "POST /api/v1/uploads",
    "PUT /api/v1/uploads/upl_0000000000000001/files",
    "POST /api/v1/uploads/upl_0000000000000001/commit",
  ]);
});

test("a board with no card or run sends neither key", async () => {
  const { d, sent } = deps();
  d.provenance = async () => ({ board: BOARD });
  expect((await link(d, { title: "  My data  " })).ok).toBe(true);
  const declare = sent.find((s) => s.path === "/api/v1/uploads")!;
  expect(declare.json.title).toBe("My data");
  expect(declare.json.source).toEqual({ station: "stn_1", stationName: "builder", path: "out/data.bin", board: BOARD });
});

test("refuses when the node does not echo the offset (an old node reads from 0 every time)", async () => {
  const { d, sent } = deps({ echoOffset: false });
  const r = await link(d);
  expect(r).toMatchObject({ ok: false, status: 409, error: "node_too_old" });
  expect(sent).toEqual([]);
});

test("a file that grows while it is read is refused, not cut short", async () => {
  const { d, sent } = deps({ growBy: 10 });
  expect(await link(d)).toMatchObject({ ok: false, status: 409, error: "file_changed" });
  expect(sent).toEqual([]);
});

test("a station that is not online is refused before anything is read", async () => {
  const { d, verbs } = deps();
  const r = await link(d, { station: { ...STATION, nodeStatus: "offline" }, path: "a.md" });
  expect(r).toMatchObject({ ok: false, status: 503, error: "station_unavailable" });
  expect(verbs).toEqual([]);
});

test("a denied path is refused before any read", async () => {
  for (const path of ["app/.env", "app/.env.local", ".ssh/config", ".ssh", "repo/.git", "keys/server.PEM", "home/.claude/settings.json", ".aws/credentials", "../outside.md", "/etc/passwd"]) {
    const { d, verbs, sent } = deps();
    let asked = false;
    d.provenance = async () => { asked = true; return { board: BOARD }; };
    const r = await link(d, { path });
    expect({ path, r }).toMatchObject({ path, r: { ok: false, status: 400, error: "path_refused" } });
    expect({ path, verbs }).toEqual({ path, verbs: [] });
    expect(sent).toEqual([]);
    expect(asked).toBe(false);
  }
});

test("a path the node denies is refused naming the path, never a 500", async () => {
  const { d, verbs } = deps({ walk: { error: "path denied: site/creds (credentials.json)" } });
  const r = await link(d, { path: "site/creds" });
  expect(r).toMatchObject({ ok: false, status: 400, error: "path_refused" });
  expect((r as { message: string }).message).toContain("site/creds");
  expect(verbs.map((v) => v.verb)).toEqual(["fs.walk"]);
});

test("a path that is not there is refused as not found", async () => {
  const { d } = deps({ walk: { error: "out/nope.md: not found" } });
  expect(await link(d, { path: "out/nope.md" })).toMatchObject({ ok: false, status: 400, error: "not_found" });
});

test("only an agent can link: the hub never acts for a person", async () => {
  const { d, verbs, sent } = deps();
  const r = await link(d, { actor: { principal: "usr_1", kind: "human" } as unknown as LinkInput["actor"] });
  expect(r).toMatchObject({ ok: false, status: 403, error: "agent_only" });
  expect(verbs).toEqual([]);
  expect(sent).toEqual([]);
});

test("a station without fs.walk is refused as too old before anything is asked of it", async () => {
  const { d, verbs } = deps();
  const r = await link(d, { station: { ...STATION, capabilities: ["health", "fs.read"] } });
  expect(r).toMatchObject({ ok: false, status: 409, error: "node_too_old" });
  expect(verbs).toEqual([]);
});

test("a node that does not know fs.walk is refused as too old", async () => {
  const { d } = deps({ walk: { error: 'descriptor: unknown verb "fs.walk"' } });
  expect(await link(d)).toMatchObject({ ok: false, status: 409, error: "node_too_old" });
});

test("no board means no link (plan P3)", async () => {
  const { d, verbs } = deps();
  d.provenance = async () => ({ refused: "This station is not on exactly one board, so the file has nowhere to belong. Link it while working a card." });
  const r = await link(d, { path: "a.md" });
  expect(r).toMatchObject({ ok: false, status: 409, error: "no_board" });
  expect(verbs).toEqual([]);
});

test("provenance is asked for the station's own id and tenant", async () => {
  const { d } = deps();
  const asked: string[][] = [];
  d.provenance = async (s, t) => { asked.push([s, t]); return { board: BOARD }; };
  await link(d);
  expect(asked).toEqual([["stn_1", "tnt_1"]]);
});

test("a file over 25 MB is refused before any read", async () => {
  const { d, verbs, sent } = deps({ walk: { files: [{ path: "", size: 25 * 1024 * 1024 + 1 }] } });
  expect(await link(d)).toMatchObject({ ok: false, status: 413, error: "file_too_large" });
  expect(verbs.map((v) => v.verb)).toEqual(["fs.walk"]);
  expect(sent).toEqual([]);
});

test("a folder with a file over 25 MB is refused before any read, even when it is listed last", async () => {
  const { d, verbs } = deps({ walk: { files: [{ path: "a.txt", size: 3 }, { path: "big.bin", size: 25 * 1024 * 1024 + 1 }] } });
  expect(await link(d, { path: "site" })).toMatchObject({ ok: false, status: 413, error: "file_too_large" });
  expect(verbs.map((v) => v.verb)).toEqual(["fs.walk"]);
});

test("a folder over 500 files is refused before any read", async () => {
  const files = Array.from({ length: 501 }, (_, i) => ({ path: `f${i}.txt`, size: 1 }));
  const { d, verbs } = deps({ walk: { files } });
  expect(await link(d, { path: "site" })).toMatchObject({ ok: false, status: 413, error: "too_many_files" });
  expect(verbs.map((v) => v.verb)).toEqual(["fs.walk"]);
});

test("a folder over 100 MB together is refused before any read", async () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.bin`, size: 21 * 1024 * 1024 }));
  const { d, verbs } = deps({ walk: { files } });
  expect(await link(d, { path: "site" })).toMatchObject({ ok: false, status: 413, error: "folder_too_large" });
  expect(verbs.map((v) => v.verb)).toEqual(["fs.walk"]);
});

test("the node's own folder caps are honoured", async () => {
  const one = { files: [{ path: "a.txt", size: 1 }] };
  expect(await link(deps({ walk: { ...one, tooMany: true } }).d, { path: "site" })).toMatchObject({ status: 413, error: "too_many_files" });
  expect(await link(deps({ walk: { ...one, tooLarge: true } }).d, { path: "site" })).toMatchObject({ status: 413, error: "folder_too_large" });
  const { d, verbs } = deps();
  await link(d);
  expect(verbs[0]).toEqual({ verb: "fs.walk", params: { key: "builder", path: "out/data.bin", maxFiles: 500, maxBytes: 100 * 1024 * 1024 } });
});

test("a folder arrives as its files, each read under the folder and uploaded relative to it", async () => {
  const a = new TextEncoder().encode("<h1>hi</h1>");
  const b = new TextEncoder().encode("body{}");
  const { d, sent, verbs } = deps({
    tree: { "site/index.html": a, "site/css/app.css": b },
    walk: { files: [{ path: "index.html", size: a.length }, { path: "css/app.css", size: b.length }] },
  });
  const r = await link(d, { path: "./site/", entry: "index.html" });
  expect(r.ok).toBe(true);
  expect(verbs.filter((v) => v.verb === "fs.read").map((v) => v.params.path)).toEqual(["site/index.html", "site/css/app.css"]);
  const declare = sent.find((s) => s.path === "/api/v1/uploads")!;
  expect(declare.json).toMatchObject({
    title: "site",
    entry: "index.html",
    files: [{ path: "index.html", bytes: a.length, sha256: sha(a) }, { path: "css/app.css", bytes: b.length, sha256: sha(b) }],
    source: { path: "site" },
  });
  expect(sent.filter((s) => s.method === "PUT").map((s) => s.path)).toEqual([
    "/api/v1/uploads/upl_0000000000000001/files?path=index.html",
    "/api/v1/uploads/upl_0000000000000001/files?path=css%2Fapp.css",
  ]);
});

test("an empty folder has nothing to link", async () => {
  const { d, sent } = deps({ walk: { files: [] } });
  expect(await link(d, { path: "site" })).toMatchObject({ ok: false, status: 400, error: "empty" });
  expect(sent).toEqual([]);
});

test("asking for a file but naming a folder (or the other way round) is refused", async () => {
  expect(await link(deps({ walk: { files: [{ path: "a.txt", size: 1 }] } }).d, { path: "site", kind: "file" })).toMatchObject({ status: 400, error: "not_a_file" });
  expect(await link(deps().d, { kind: "folder" })).toMatchObject({ status: 400, error: "not_a_folder" });
});

test("a secret found by Superlibrary is reported with file and line, and nothing is overridden", async () => {
  const { d, sent } = deps();
  const base = d.client.asService(AGENT);
  d.client.asService = () => ({
    async request(method, path, init) {
      if (path.endsWith("/commit")) return Response.json({ error: "secret_found", findings: [{ path: "data.bin", line: 3, rule: "github-token" }] }, { status: 422 });
      return base.request(method, path, init);
    },
  });
  const r = await link(d);
  expect(r).toMatchObject({ ok: false, status: 422, error: "secret_found" });
  expect((r as { message: string }).message).toContain("data.bin line 3 (github-token)");
  expect(sent.find((s) => s.path.endsWith("/override"))).toBeUndefined();
});

test("Superlibrary's other refusals come back with their own error and reason", async () => {
  const { d } = deps();
  d.client.asService = () => ({
    async request() { return Response.json({ error: "path_refused", path: "data.bin", reason: "denied", rule: "*.key" }, { status: 400 }); },
  });
  expect(await link(d)).toMatchObject({ ok: false, status: 400, error: "path_refused", message: "data.bin: denied (*.key)" });
  // Exactly what Superlibrary's checkLinkSource answers (sources/link.ts).
  d.client.asService = () => ({ async request() { return Response.json({ error: "scope_mismatch", detail: "a linked file belongs to the board of its run" }, { status: 400 }); } });
  expect(await link(d)).toMatchObject({ ok: false, status: 400, error: "scope_mismatch", message: "a linked file belongs to the board of its run" });
  d.client.asService = () => ({ async request() { return Response.json({ error: "too_many_files", limit: 500 }, { status: 413 }); } });
  expect(await link(d)).toMatchObject({ ok: false, status: 413, error: "too_many_files", message: "Superlibrary refused the link (413, too_many_files)." });
  d.client.asService = () => ({ async request() { return new Response("boom", { status: 500 }); } });
  expect(await link(d)).toMatchObject({ ok: false, status: 502, error: "library_refused" });
});

test("Superlibrary is asked as the hub for the agent, and nobody else", async () => {
  const { d } = deps();
  const who: unknown[] = [];
  const inner = d.client.asService;
  d.client.asService = (w) => { who.push(w); return inner(w); };
  await link(d);
  expect(who).toEqual([AGENT]);
});

test("the real broker module is LinkDeps.broker as it is (no adapter): a node that is not connected is unavailable", async () => {
  const { d } = deps();
  const r = await linkArtifact({ ...d, broker: realBroker }, { station: { ...STATION, nodeId: "node_not_connected" }, path: "out/data.bin", actor: AGENT });
  expect(r).toMatchObject({ ok: false, status: 503, error: "station_unavailable" });
});

test("a file whose size changes between chunks is refused as torn, not spliced", async () => {
  // The first chunk agrees with the walk; the second reports a different size (an edit mid-read).
  const { d, sent, verbs } = deps({ sizeAt: (off, size) => (off === 0 ? size : size + 1) });
  expect(await link(d)).toMatchObject({ ok: false, status: 409, error: "file_changed" });
  expect(verbs.filter((v) => v.verb === "fs.read").length).toBe(2);
  expect(sent).toEqual([]);
});

test("a chunk that reports no size is not trusted", async () => {
  const { d, sent } = deps({ sizeAt: () => undefined as unknown as number });
  expect(await link(d)).toMatchObject({ ok: false, status: 409, error: "file_changed" });
  expect(sent).toEqual([]);
});

test("a walked name Superlibrary would refuse is refused before any read, with a sentence", async () => {
  const cases: Array<[string, string]> = [
    ["a\\b.txt", "backslash"],
    ["bell\u0007.txt", "control character"],
    [`${"d/".repeat(520)}x.txt`, "too long"],
    ["sub/.env", ".env*"],
  ];
  for (const [name, why] of cases) {
    const { d, verbs, sent } = deps({ walk: { files: [{ path: "ok.txt", size: 1 }, { path: name, size: 1 }] } });
    const r = await link(d, { path: "site" });
    expect({ name, r }).toMatchObject({ name, r: { ok: false, status: 400, error: "path_refused" } });
    expect((r as { message: string }).message).toContain(why);
    expect(verbs.map((v) => v.verb)).toEqual(["fs.walk"]);
    expect(sent).toEqual([]);
  }
});

test("a requested path with a control character or over 1024 characters is refused before anything is asked", async () => {
  for (const path of ["out/a\u0000b.md", `${"d/".repeat(520)}x.md`]) {
    const { d, verbs } = deps();
    expect(await link(d, { path })).toMatchObject({ ok: false, status: 400, error: "path_refused" });
    expect(verbs).toEqual([]);
  }
});

test("tooMany and tooLarge refuse whatever else the walk carries (truncatedBy, skipped unreadable)", async () => {
  const one = { files: [{ path: "a.txt", size: 1 }] };
  const r1 = await link(deps({ walk: { ...one, tooMany: true }, extra: { truncatedBy: "entries" } }).d, { path: "site" });
  expect(r1).toMatchObject({ status: 413, error: "too_many_files" });
  const r2 = await link(deps({ walk: { ...one, tooLarge: true }, extra: { truncatedBy: "bytes" } }).d, { path: "site" });
  expect(r2).toMatchObject({ status: 413, error: "folder_too_large" });
});

test("the walk's root is never compared: a root that differs from the request still links", async () => {
  const { d } = deps({ extra: { root: "./out//data.bin" } });
  expect((await link(d)).ok).toBe(true);
});

test("a node read error is never relayed: it may carry host-absolute paths", async () => {
  const { d, sent } = deps({ readError: "open /srv/home/someone/workspace/out/data.bin: permission denied" });
  const r = await link(d);
  expect(r).toMatchObject({ ok: false, status: 502, error: "read_failed", message: "Could not read out/data.bin; link it again." });
  expect((r as { message: string }).message).not.toContain("/srv");
  expect(sent).toEqual([]);
});

test("a walked name is judged from the workspace too, not only from the folder", async () => {
  for (const [folder, entry] of [[".config", "gcloud/credentials.db"], [".docker", "config.json"], [".local", "share/opencode/x.json"]] as const) {
    const { d, verbs, sent } = deps({ walk: { files: [{ path: "ok.txt", size: 1 }, { path: entry, size: 1 }] } });
    const r = await link(d, { path: folder });
    expect({ folder, r }).toMatchObject({ folder, r: { ok: false, status: 400, error: "path_refused" } });
    expect((r as { message: string }).message).toContain(`${folder}/${entry}`);
    expect(verbs.map((v) => v.verb)).toEqual(["fs.walk"]);
    expect(sent).toEqual([]);
  }
});

test("what the walk left out comes back with the link", async () => {
  const r = await link(deps().d);
  expect(r).toMatchObject({ ok: true, skipped: [{ path: "locked.txt", reason: "unreadable" }] });
});

test("Superlibrary's own detail is relayed, capped at 500 characters", async () => {
  const { d } = deps();
  d.client.asService = () => ({ async request() { return Response.json({ error: "invalid", detail: "q".repeat(5000) }, { status: 400 }); } });
  const r = await link(d);
  expect(r).toMatchObject({ ok: false, status: 400, error: "invalid" });
  expect((r as { message: string }).message).toBe("q".repeat(500));
});

test("the too-old sentence is the brief's", async () => {
  const r = await link(deps({ echoOffset: false }).d);
  expect((r as { message: string }).message).toBe("This node is too old to link files; update it and try again.");
});

// ─── Final-review fix wave ────────────────────────────────────────────────────

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wraps the fake node so every fs.read first waits `ms`, and records what happened. */
function slowReads(d: LinkDeps, ms: number, onRead?: (n: number) => void) {
  const inner = d.broker;
  let n = 0;
  d.broker = {
    async request(node, verb, p, o) {
      if (verb === "fs.read") { onRead?.(++n); await pause(ms); }
      return inner.request(node, verb, p, o);
    },
  };
}

test("a link past its deadline stops between chunks and links nothing", async () => {
  const { d, sent, verbs } = deps();
  slowReads(d, 40);
  const r = await link(d, { deadlineMs: 60 });
  expect(r).toMatchObject({ ok: false, status: 503, error: "timed_out", message: "The link took too long; nothing was linked." });
  expect(verbs.filter((v) => v.verb === "fs.read").length).toBeLessThan(3);
  expect(sent).toEqual([]);
});

test("a deadline that passes after the last read stops before the declare", async () => {
  const { d, sent } = deps({ tree: { "a.md": new Uint8Array([1, 2, 3]) } });
  slowReads(d, 40);
  expect(await link(d, { path: "a.md", deadlineMs: 20 })).toMatchObject({ ok: false, error: "timed_out" });
  expect(sent).toEqual([]);
});

test("a link whose caller went away stops and links nothing", async () => {
  const { d, sent, verbs } = deps();
  const ctl = new AbortController();
  slowReads(d, 1, (n) => { if (n === 1) ctl.abort(); });
  const r = await link(d, { signal: ctl.signal });
  expect(r).toMatchObject({ ok: false, status: 503, error: "cancelled", message: "The link was cancelled; nothing was linked." });
  expect(verbs.filter((v) => v.verb === "fs.read").length).toBe(1);
  expect(sent).toEqual([]);
});

test("Superlibrary or Accounts down is a plain refusal, never the exception's text", async () => {
  for (const at of ["/api/v1/uploads", "/files?path=", "token"]) {
    const { d } = deps();
    const inner = d.client.asService(AGENT);
    d.client.asService = () => ({
      async request(method, path, init) {
        if (at === "token" || path.includes(at)) throw new Error("connect ECONNREFUSED 10.0.0.9:443 /internal/secret-path");
        return inner.request(method, path, init);
      },
    });
    const r = await link(d);
    expect({ at, r }).toMatchObject({ at, r: { ok: false, status: 503, error: "library_unavailable", message: "Superlibrary is unavailable right now; nothing was linked. Try again later." } });
  }
});

test("a commit with no answer is retried once; a second silence is reported honestly", async () => {
  const commits: number[] = [];
  const run = async (answers: Array<"throw" | Response>) => {
    const { d } = deps();
    const inner = d.client.asService(AGENT);
    let i = 0;
    d.client.asService = () => ({
      async request(method, path, init) {
        if (path.endsWith("/commit")) {
          commits.push(i);
          const a = answers[i++]!;
          if (a === "throw") throw new Error("aborted");
          return a;
        }
        return inner.request(method, path, init);
      },
    });
    return link(d);
  };
  const ok = Response.json({ itemId: "itm_0000000000000001", version: 1, url: "u", sha256: "x", mediaType: "m", bytes: 1 }, { status: 201 });
  expect(await run(["throw", ok])).toMatchObject({ ok: true, itemId: "itm_0000000000000001" });
  expect(await run(["throw", "throw"])).toMatchObject({ ok: false, status: 503, error: "commit_unconfirmed" });
  // A retry of a session that did commit answers 200 with the first result (Superlibrary's committed()).
  expect(await run(["throw", Response.json({ itemId: "itm_0000000000000001", version: 1, url: "u", sha256: "x", mediaType: "m", bytes: 1 }, { status: 200 })])).toMatchObject({ ok: true, itemId: "itm_0000000000000001" });
  // A 409 from commit means it did not commit: relayed as such, never "the link was made".
  const notMade = await run(["throw", Response.json({ error: "incomplete", missing: ["data.bin"] }, { status: 409 })]);
  expect(notMade).toMatchObject({ ok: false, status: 409, error: "incomplete" });
  expect((notMade as { message: string }).message).not.toContain("was made");
  expect(commits.length).toBe(8);
});

test("the tooMany sentence says what stopped the walk", async () => {
  const one = { files: [{ path: "a.txt", size: 1 }], tooMany: true };
  const msg = async (by?: string) => ((await link(deps({ walk: one, extra: by ? { truncatedBy: by } : {} }).d, { path: "site" })) as { message: string }).message;
  expect(await msg("files")).toBe("A folder may have at most 500 files.");
  expect(await msg()).toBe("A folder may have at most 500 files.");
  expect(await msg("skipped")).toContain("entries that cannot be linked");
  expect(await msg("entries")).toContain("too big to list");
});

test("entry is relative to the linked folder; a workspace-relative entry naming the folder is accepted", async () => {
  const a = new TextEncoder().encode("x");
  for (const entry of ["index.html", "site/index.html", "./site/index.html"]) {
    const { d, sent } = deps({ tree: { "site/index.html": a }, walk: { files: [{ path: "index.html", size: 1 }] } });
    expect((await link(d, { path: "site", entry })).ok).toBe(true);
    expect({ entry, sent: sent[0]!.json.entry }).toEqual({ entry, sent: "index.html" });
  }
});

test("the workspace itself is not linked", async () => {
  for (const path of [".", "./", ""]) {
    const { d, verbs } = deps();
    expect(await link(d, { path })).toMatchObject({ ok: false, status: 400, error: "path_refused", message: "Link a folder inside the workspace, not the workspace itself." });
    expect(verbs).toEqual([]);
  }
});

test(`at most ${MAX_CONCURRENT_LINKS} links run at once; the next waits, and gives up at its deadline`, async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const walks: number[] = [];
  const gated = () => {
    const { d } = deps();
    const inner = d.broker;
    d.broker = { async request(n, verb, p, o) { if (verb === "fs.walk") { walks.push(1); await gate; } return inner.request(n, verb, p, o); } };
    return d;
  };
  const held = Array.from({ length: MAX_CONCURRENT_LINKS }, () => link(gated()));
  const fourth = link(gated());
  const late = link(gated(), { deadlineMs: 30 });
  await pause(10);
  expect(walks.length).toBe(MAX_CONCURRENT_LINKS);
  expect(await late).toMatchObject({ ok: false, error: "timed_out" });
  expect(walks.length).toBe(MAX_CONCURRENT_LINKS);
  open();
  const all = await Promise.all([...held, fourth]);
  expect(all.every((r) => r.ok)).toBe(true);
  expect(walks.length).toBe(MAX_CONCURRENT_LINKS + 1);
});

test("an already-cancelled link is refused at once, without touching the node", async () => {
  const { d, verbs } = deps();
  const ctl = new AbortController();
  ctl.abort();
  expect(await link(d, { signal: ctl.signal })).toMatchObject({ ok: false, error: "cancelled" });
  expect(verbs).toEqual([]);
});

test("an already-cancelled link waiting for a slot is refused at once, not at its deadline", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const gated = () => {
    const { d } = deps();
    const inner = d.broker;
    d.broker = { async request(n, verb, p, o) { if (verb === "fs.walk") await gate; return inner.request(n, verb, p, o); } };
    return d;
  };
  const held = Array.from({ length: MAX_CONCURRENT_LINKS }, () => link(gated()));
  const ctl = new AbortController();
  ctl.abort();
  const r = await Promise.race([link(gated(), { signal: ctl.signal }), pause(200).then(() => "still waiting")]);
  expect(r).toMatchObject({ ok: false, error: "cancelled" });
  open();
  await Promise.all(held);
});
