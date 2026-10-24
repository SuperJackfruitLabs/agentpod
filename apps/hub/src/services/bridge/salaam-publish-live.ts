import { readExecutionArtifactBundle } from "../evidence/execution";
import { superlibraryClient } from "../superlibrary/client";
import { superlibraryConfig } from "../superlibrary/config";
import { executionExportStore } from "../superlibrary/execution-export-store";
import { readLibraryContent } from "../superlibrary/read-content";
import type { SalaamWorkCompletion } from "../../../../../packages/contract/src/salaam-work-completion";
import { publishSalaamWork } from "./salaam-publish";
import type { SuperpipelineClient } from "./superpipeline";

/** Where a Library item is shown; the work record links references on this host. */
export function libraryAppUrl(): string | null {
  const explicit = (process.env.SUPERLIBRARY_APP_URL ?? "").trim();
  return explicit || superlibraryConfig()?.url || null;
}

/** The production publisher for one strict run: original-owner reads, the hub's Library
 * service acting for the run's agent principal, and the card's own reference list. */
export function livePublisher(input: {
  tenantId: string;
  source: string;
  runId: string;
  boardId: string;
  cardId: string;
  principalId: string;
  workRequestId: string;
  client: Pick<SuperpipelineClient, "context" | "addCardReference">;
}) {
  return async (completion: import("zod").infer<typeof SalaamWorkCompletion>) => {
    const title = (await input.client.context(input.runId)).card.title || input.cardId;
    return publishSalaamWork(
      {
        readBundle: (ids) =>
          readExecutionArtifactBundle(
            input.tenantId,
            input.source,
            input.runId,
            input.boardId,
            input.cardId,
            ids,
          ),
        library:
          superlibraryClient()?.asService({ principal: input.principalId, kind: "agent" }) ??
          null,
        appUrl: libraryAppUrl(),
        store: executionExportStore,
        readContent: readLibraryContent,
        addReference: async ({ url, title }) => {
          await input.client.addCardReference(input.cardId, {
            url,
            title,
            provider: "superlibrary",
            addedBy: "agent",
          });
        },
      },
      {
        workRequestId: input.workRequestId,
        tenantId: input.tenantId,
        principalId: input.principalId,
        runId: input.runId,
        title,
      },
      completion,
    );
  };
}
