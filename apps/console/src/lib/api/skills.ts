import {
  SkillArtifactMetadata,
  SkillHubOperation,
  SkillHubOperationSummary,
  SkillVerifyResult,
} from "@agentpod/contract";
import { http } from "./client";

const stationPath = (id: string) =>
  `/api/stations/${encodeURIComponent(id)}/skills`;
const operationPath = (stationId: string, id: string) =>
  `${stationPath(stationId)}/operations/${encodeURIComponent(id)}`;
const nativeOperationPath = (stationId: string, id: string) =>
  `${stationPath(stationId)}/native/operations/${encodeURIComponent(id)}`;
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
function checkedOperation(stationId: string, data: unknown, id?: string) {
  const operation = SkillHubOperation.parse(data);
  if (operation.stationId !== stationId)
    throw new Error("Operation belongs to a different station");
  if (id && operation.id !== id)
    throw new Error("Response belongs to a different operation");
  for (const plan of [operation.plan, operation.receipt?.plan]) {
    if (
      plan &&
      (plan.operationId !== operation.id ||
        plan.action !== operation.action ||
        plan.binding.nodeId !== operation.nodeId ||
        plan.binding.stationKey !== operation.stationKey ||
        plan.binding.harness !== operation.harness ||
        plan.binding.profile !== operation.profile)
    )
      throw new Error("Plan identity does not match its operation");
  }
  return operation;
}
export const listSkillArtifacts = async () =>
  SkillArtifactMetadata.array().parse(await http("/api/skills/artifacts"));
export const uploadSkillArtifact = async (
  file: File,
  harness: string,
  profile: string,
) => {
  if (file.size === 0 || file.size > 32 * 1024 * 1024)
    throw new Error("Choose an archive between 1 byte and 32 MiB");
  const query = new URLSearchParams({ harness, profile });
  return SkillArtifactMetadata.parse(
    await http(`/api/skills/artifacts?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    }),
  );
};
export const listSkillOperations = async (stationId: string) => {
  const operations = SkillHubOperationSummary.array().parse(
    await http(`${stationPath(stationId)}/operations`),
  );
  if (operations.some((operation) => operation.stationId !== stationId))
    throw new Error("History belongs to a different station");
  return operations;
};
export const listNativeSkillOperations = async (stationId: string) => {
  const operations = SkillHubOperationSummary.array().parse(
    await http(`${stationPath(stationId)}/native/operations`),
  );
  if (operations.some((operation) => operation.stationId !== stationId || operation.kind !== "native"))
    throw new Error("Native history belongs to a different station");
  return operations;
};
export const getSkillOperation = async (stationId: string, id: string) =>
  checkedOperation(stationId, await http(operationPath(stationId, id)), id);
export const getNativeSkillOperation = async (stationId: string, id: string) => {
  const operation = checkedOperation(stationId, await http(nativeOperationPath(stationId, id)), id);
  if (operation.kind !== "native") throw new Error("Operation is not native placement");
  return operation;
};
export const inspectSkillOperation = async (stationId: string, id: string) =>
  checkedOperation(
    stationId,
    await http(`${operationPath(stationId, id)}/inspect`, post({})),
    id,
  );
export const inspectNativeSkillOperation = async (stationId: string, id: string) =>
  checkedOperation(
    stationId,
    await http(`${nativeOperationPath(stationId, id)}/inspect`, post({})),
    id,
  );
export const planSkillInstall = async (
  stationId: string,
  artifactId: string,
  requestId: string,
) =>
  checkedOperation(
    stationId,
    await http(
      `${stationPath(stationId)}/plan`,
      post({ artifactId, requestId }),
    ),
  );
export const planSkillRollback = async (
  stationId: string,
  profile: string,
  requestId: string,
) =>
  checkedOperation(
    stationId,
    await http(
      `${stationPath(stationId)}/rollback`,
      post({ profile, requestId }),
    ),
  );
export const planNativeSkillPlacement = async (
  stationId: string,
  profile: string,
  action: "activate" | "deactivate" | "rollback",
  requestId: string,
) => {
  const operation = checkedOperation(
    stationId,
    await http(`${stationPath(stationId)}/native/plan`, post({ profile, action, requestId })),
  );
  if (operation.kind !== "native") throw new Error("Response is not native placement");
  return operation;
};
export const applySkillOperation = async (
  stationId: string,
  id: string,
  planDigest: string,
) =>
  checkedOperation(
    stationId,
    await http(`${operationPath(stationId, id)}/apply`, post({ planDigest })),
    id,
  );
export const applyNativeSkillOperation = async (
  stationId: string,
  id: string,
  planDigest: string,
) => {
  const operation = checkedOperation(
    stationId,
    await http(`${nativeOperationPath(stationId, id)}/apply`, post({ planDigest })),
    id,
  );
  if (operation.kind !== "native") throw new Error("Response is not native placement");
  return operation;
};
export const verifySkillFiles = async (stationId: string, profile: string) => {
  const result = SkillVerifyResult.parse(
    await http(`${stationPath(stationId)}/verify`, post({ profile })),
  );
  if (result.profile !== profile)
    throw new Error("Verification belongs to a different profile");
  return result;
};
export const verifyNativeSkillPlacement = async (stationId: string, profile: string) => {
  const result = SkillVerifyResult.parse(
    await http(`${stationPath(stationId)}/native/verify`, post({ profile })),
  );
  if (result.profile !== profile) throw new Error("Verification belongs to a different profile");
  return result;
};
