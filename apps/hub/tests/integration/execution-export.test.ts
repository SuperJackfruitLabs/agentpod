import { afterAll, beforeAll, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { rawSql } from "../../src/db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { executionExportStore } from "../../src/services/superlibrary/execution-export-store";
import {
  evidenceHash,
  manifestBytes,
  reserveExecutionExport,
  runExecutionExport,
} from "../../src/services/superlibrary/execution-export";
import corpus from "../../../../packages/contract/src/fixtures/execution-evidence-v1.json";
const requestId = crypto.randomUUID();
const manifest = corpus.success[0]!.value;
const scope = {
  requestId,
  tenantId: BOOTSTRAP_TENANT_ID,
  principalId: manifest.binding.principal_id,
};
beforeAll(ensurePgMigrations);
afterAll(async () => {
  await rawSql`DELETE FROM execution_exports WHERE request_id=${requestId}`;
});
test("Postgres preserves original scoped upload and immutable bytes across exporter restart", async () => {
  await reserveExecutionExport(executionExportStore, { ...scope, manifest });
  const bytes = manifestBytes(manifest);
  let declarations = 0,
    commits = 0;
  const remote = {
    async request(method: string, path: string) {
      if (path === "/api/v1/uploads") {
        declarations++;
        const [saved] =
          await rawSql`SELECT status,manifest,digest FROM execution_exports WHERE request_id=${requestId}`;
        expect(saved!.status).toBe("declaring");
        expect(saved!.digest).toBe(evidenceHash(bytes));
        return Response.json({ uploadId: "upl_restart" });
      }
      const [saved] =
        await rawSql`SELECT upload_id FROM execution_exports WHERE request_id=${requestId}`;
      expect(saved!.upload_id).toBe("upl_restart");
      if (path.endsWith("/commit")) {
        commits++;
        if (commits === 1) throw Error("lost remote commit response");
        return Response.json({
          itemId: "itm_restarted",
          version: 1,
          sha256: evidenceHash(bytes),
          bytes: bytes.length,
        });
      }
      if (path.endsWith("/embed"))
        return Response.json({
          version: 1,
          downloadUrl: "https://content.test/saved",
          entry: "execution-evidence.json",
        });
      return new Response(null, { status: 200 });
    },
  };
  await expect(
    runExecutionExport(executionExportStore, scope, remote, async () => bytes),
  ).rejects.toThrow("lost remote commit response");
  // No process-memory export object is supplied to recovery; DB is the sole source.
  const recovered = await runExecutionExport(
    { ...executionExportStore },
    scope,
    remote,
    async () => bytes,
  );
  expect(recovered.status).toBe("committed");
  expect(declarations).toBe(1);
  expect(commits).toBe(2);
  expect(
    await executionExportStore.get(requestId, scope.tenantId, "foreign"),
  ).toBeNull();
  const [saved] =
    await rawSql`SELECT receipt,status FROM execution_exports WHERE request_id=${requestId}`;
  expect(saved!.status).toBe("committed");
  expect(saved!.receipt.itemId).toBe("itm_restarted");
});
