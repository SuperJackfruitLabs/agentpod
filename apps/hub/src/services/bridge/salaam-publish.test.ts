import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import corpus from "../../../../../packages/contract/src/fixtures/execution-evidence-v1.json";
import type { ExecutionArtifactBundleV1 } from "../../../../../packages/contract/src/execution-evidence";
import { libraryDigest, type ExportRecord, type ExportStore } from "../superlibrary/execution-export";
import { agentHandoff, deliverableExportId, publishSalaamWork, type PublishDeps } from "./salaam-publish";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const RUN = "run_abcdef123";
const DIR = "runs/" + RUN + "/";
const base = corpus.success[0]!.value;
const session = randomUUID();

function station(files: Record<string, string>, opts: { tamper?: string } = {}) {
  const artifacts = new Map<string, { path?: string; content: string }>();
  const deliverables = Object.entries(files).map(([path, content]) => {
    const id = randomUUID();
    artifacts.set(id, { path, content });
    return { path: DIR + path, sha256: sha(content), artifact_id: id };
  });
  const completionId = randomUUID();
  artifacts.set(completionId, { content: JSON.stringify({ deliverables }) });
  const reads: string[][] = [];
  const readBundle = async (ids: string[]): Promise<ExecutionArtifactBundleV1> => {
    reads.push(ids);
    const list = ids.map((id) => {
      const a = artifacts.get(id)!;
      const content = a.path && a.path === opts.tamper ? a.content + " (changed)" : a.content;
      const bytes = Buffer.from(content);
      return { id, session_id: session, digest: sha(bytes), bytes: bytes.length, disposition: "produced" as const, content_base64: bytes.toString("base64") };
    });
    const evidence = {
      ...structuredClone(base),
      as_of: new Date(Date.now() + reads.length).toISOString(),
      artifacts: list.map(({ content_base64: _c, ...a }) => a),
    };
    return { schema_version: "salaam-execution-artifacts/v1", evidence, artifacts: list } as ExecutionArtifactBundleV1;
  };
  return { completionId, readBundle, reads, deliverables };
}

function library() {
  const uploads = new Map<string, Map<string, Uint8Array>>();
  const calls: string[] = [];
  let declared: { title?: string } = {};
  const files = () => [...(uploads.get("upl_1") ?? new Map()).entries()].map(([path, bytes]) => ({ path, bytes, sha256: sha(bytes) }));
  const caller = {
    async request(method: string, path: string, init?: { json?: any; body?: Uint8Array }) {
      calls.push(method + " " + path.split("?")[0]);
      if (path === "/api/v1/uploads") {
        declared = init?.json ?? {};
        uploads.set("upl_1", new Map());
        return Response.json({ uploadId: "upl_1" });
      }
      if (path.startsWith("/api/v1/uploads/upl_1/files")) {
        uploads.get("upl_1")!.set(decodeURIComponent(path.split("path=")[1]!), init!.body!);
        return new Response(null, { status: 200 });
      }
      const all = files();
      const total = all.reduce((n, f) => n + f.bytes.length, 0);
      if (path.endsWith("/commit")) return Response.json({ itemId: "itm_0123456789abcdef", version: 1, sha256: libraryDigest(all), bytes: total });
      if (path.endsWith("/verification"))
        return Response.json({
          schemaVersion: "superlibrary-upload-verification/v1",
          uploadId: "upl_1",
          itemId: "itm_0123456789abcdef",
          sha256: libraryDigest(all),
          bytes: total,
          version: 1,
          url: "https://lib.test/_view?sig=abc",
          entry: "execution-manifest.json",
          files: all.map((f) => ({ path: f.path })),
        });
      return new Response(null, { status: 404 });
    },
  };
  const readContent = async (url: string) => {
    const path = decodeURIComponent(new URL(url).pathname.replace("/s/abc/", ""));
    return uploads.get("upl_1")!.get(path)!;
  };
  return { caller, readContent, calls, declared: () => declared };
}

function store(): ExportStore & { rows: Map<string, ExportRecord> } {
  const rows = new Map<string, ExportRecord>();
  return {
    rows,
    async reserve(r) {
      if (!rows.has(r.requestId)) rows.set(r.requestId, structuredClone(r));
      return structuredClone(rows.get(r.requestId)!);
    },
    async get(id, t, p) {
      const r = rows.get(id);
      return r && r.tenantId === t && r.principalId === p ? structuredClone(r) : null;
    },
    async change(id, from, to, patch = {}) {
      const r = rows.get(id)!;
      if (r.status !== from) return false;
      rows.set(id, { ...r, ...patch, status: to });
      return true;
    },
  };
}

const scope = { workRequestId: randomUUID(), tenantId: "tenant", principalId: base.binding.principal_id, runId: RUN, title: "RFC 9110 on 502" };
const completion = (id: string) => ({
  version: 1 as const,
  state: "verified" as const,
  work_request_id: scope.workRequestId,
  task_id: randomUUID(),
  plan_revision: 1,
  binding_digest: "a".repeat(64),
  completion_id: id,
  evidence_digest: "b".repeat(64),
});

function deps(s: ReturnType<typeof station>, lib = library(), st = store()) {
  const references: { url: string; title: string }[] = [];
  const d: PublishDeps = {
    readBundle: s.readBundle,
    library: lib.caller,
    appUrl: "https://app.lib.test/",
    store: st,
    readContent: lib.readContent,
    addReference: async (r) => {
      references.push(r);
    },
  };
  return { d, references, lib, st };
}

test("a verified completion publishes its deliverables and reports the agent's own handoff", async () => {
  const s = station({
    "answer.md": "\"The 502 status code...\" (Section 15.6.3)\n",
    "handoff.json": JSON.stringify({ summary: "Quoted RFC 9110", findings: ["15.6.3"], verification: "forged" }),
  });
  const { d, references, lib } = deps(s);
  const out = await publishSalaamWork(d, scope, completion(s.completionId));
  expect(out.agent).toEqual({ summary: "Quoted RFC 9110", findings: ["15.6.3"] });
  expect(out.publication).toBe("published");
  expect(out.library?.url).toBe("https://app.lib.test/a/itm_0123456789abcdef");
  expect(out.deliverables).toEqual([
    {
      path: "answer.md",
      sha256: s.deliverables[0]!.sha256,
      url: "https://app.lib.test/a/itm_0123456789abcdef",
      libraryFile: `artifacts/${s.deliverables[0]!.artifact_id}.json`,
    },
  ]);
  expect(references).toEqual([{ url: "https://app.lib.test/a/itm_0123456789abcdef", title: "RFC 9110 on 502" }]);
  expect(lib.declared().title).toBe("RFC 9110 on 502");
  // The handoff file is reported, not uploaded.
  expect(lib.calls.filter((c) => c.startsWith("PUT")).length).toBe(2);
  // Retrying reuses the one upload.
  await publishSalaamWork(d, scope, completion(s.completionId));
  expect(lib.calls.filter((c) => c === "POST /api/v1/uploads")).toHaveLength(1);
});

test("bytes that differ from the verified digest are never published", async () => {
  const s = station({ "answer.md": "verified", "handoff.json": "{}" }, { tamper: "answer.md" });
  const { d, lib, references } = deps(s);
  await expect(publishSalaamWork(d, scope, completion(s.completionId))).rejects.toThrow(/differ from verification/);
  expect(lib.calls).toEqual([]);
  expect(references).toEqual([]);
});

test("a completion without the agent's handoff is refused", async () => {
  const s = station({ "answer.md": "verified" });
  const { d, lib } = deps(s);
  await expect(publishSalaamWork(d, scope, completion(s.completionId))).rejects.toThrow(/handoff/);
  expect(lib.calls).toEqual([]);
});

test("without a Library the handoff says so and lists the verified digests", async () => {
  const s = station({ "answer.md": "verified", "handoff.json": "plain words" });
  const { d } = deps(s);
  const out = await publishSalaamWork({ ...d, library: null }, scope, completion(s.completionId));
  expect(out).toEqual({
    agent: { summary: "plain words" },
    publication: "unavailable",
    deliverables: [{ path: "answer.md", sha256: sha("verified") }],
  });
});

test("handoff parsing keeps the agent's object and rejects oversize or invalid text", () => {
  expect(agentHandoff(Buffer.from('{"a":1,"deliverables":[]}'))).toEqual({ a: 1 });
  expect(agentHandoff(Buffer.from("[1,2]"))).toEqual({ summary: "[1,2]" });
  expect(() => agentHandoff(Buffer.alloc(64 * 1024 + 1, 97))).toThrow(/64 KiB/);
  expect(() => agentHandoff(Buffer.from([0xff, 0xfe]))).toThrow();
  expect(deliverableExportId("x")).toBe(deliverableExportId("x"));
  expect(deliverableExportId("x")).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
});
