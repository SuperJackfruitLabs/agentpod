import { expect, test, spyOn } from "bun:test";
import { attachExecutionReference } from "./execution-reference";
import * as roster from "./roster";
import { SuperpipelineClient } from "./superpipeline";
import {
  evidenceHash,
  manifestBytes,
  type ExportRecord,
  type ExportStore,
} from "../superlibrary/execution-export";
import corpus from "../../../../../packages/contract/src/fixtures/execution-evidence-v1.json";
test("reference uses original principal configuration and stays independent of artifact success", async () => {
  const originalFlag = process.env.ENABLE_SUPERPIPELINE_BRIDGE,
    originalUrl = process.env.SUPERPIPELINE_BASE_URL;
  process.env.ENABLE_SUPERPIPELINE_BRIDGE = "true";
  process.env.SUPERPIPELINE_BASE_URL = "https://pipeline.test";
  const manifest = corpus.success[0]!.value,
    bytes = manifestBytes(manifest);
  const record: ExportRecord = {
    requestId: crypto.randomUUID(),
    tenantId: "tenant",
    principalId: manifest.binding.principal_id,
    manifest,
    digest: evidenceHash(bytes),
    status: "committed",
    uploadId: "upl_1",
    receipt: {
      itemId: "itm_1",
      version: 1,
      sha256: evidenceHash(bytes),
      bytes: bytes.length,
    },
  };
  let writes = 0,
    calls = 0;
  const store = {
    async change() {
      writes++;
      return true;
    },
  } as unknown as ExportStore;
  const read = spyOn(roster, "readBridgeRoster").mockResolvedValue([]);
  const credential = spyOn(roster, "bridgePlaneCredential").mockReturnValue(
    async () => "original",
  );
  const post = spyOn(
    SuperpipelineClient.prototype,
    "addEvidenceReference",
  ).mockImplementation(async (run, input) => {
    calls++;
    expect(run).toBe(manifest.binding.run.id);
    expect(input.manifest_sha256).toBe(record.digest);
    return { reference_id: "ref_1", verification: "unverified" };
  });
  try {
    expect(await attachExecutionReference(store, record, "original")).toBe(
      "unavailable",
    );
    expect(calls).toBe(0);
    expect(record.status).toBe("committed");
    read.mockResolvedValue([
      {
        key: "original",
        tenantId: "tenant",
        boardId: manifest.task.board_id,
        stationId: manifest.binding.station_id,
        credentialSource: {
          principalId: manifest.binding.principal_id,
          organizationId: manifest.binding.organization_id,
        },
      } as Awaited<ReturnType<typeof roster.readBridgeRoster>>[number],
    ]);
    expect(await attachExecutionReference(store, record, "original")).toBe(
      "attached_unverified",
    );
    expect(calls).toBe(1);
    expect(writes).toBe(1);
    post.mockRejectedValue(Error("stale lease"));
    expect(await attachExecutionReference(store, record, "original")).toBe(
      "unavailable",
    );
    expect(record.status).toBe("committed");
  } finally {
    read.mockRestore();
    credential.mockRestore();
    post.mockRestore();
    if (originalFlag === undefined)
      delete process.env.ENABLE_SUPERPIPELINE_BRIDGE;
    else process.env.ENABLE_SUPERPIPELINE_BRIDGE = originalFlag;
    if (originalUrl === undefined) delete process.env.SUPERPIPELINE_BASE_URL;
    else process.env.SUPERPIPELINE_BASE_URL = originalUrl;
  }
});
