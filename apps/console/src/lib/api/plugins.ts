import { SkillHubOperationSummary } from "@agentpod/contract";
import { http } from "./client";
import { checkedOperation } from "./skills";

// Console plugin management (#553). The hub keeps these operations beside skill
// operations but under their own routes, capability and kind.
const pluginPath = (stationId: string) => `/api/stations/${encodeURIComponent(stationId)}/plugins`;
const operationPath = (stationId: string, id: string) => `${pluginPath(stationId)}/operations/${encodeURIComponent(id)}`;
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function checkedPluginOperation(stationId: string, data: unknown, id?: string) {
  const operation = checkedOperation(stationId, data, id);
  if (operation.kind !== "plugin") throw new Error("Operation is not a plugin operation");
  return operation;
}

export const planPluginOperation = async (stationId: string, action: "enable" | "disable", requestId: string) =>
  checkedPluginOperation(stationId, await http(`${pluginPath(stationId)}/plan`, post({ requestId, action })));

export const listPluginOperations = async (stationId: string) => {
  const operations = SkillHubOperationSummary.array().parse(await http(`${pluginPath(stationId)}/operations`));
  if (operations.some((operation) => operation.stationId !== stationId || operation.kind !== "plugin"))
    throw new Error("Plugin history belongs to a different station");
  return operations;
};

export const getPluginOperation = async (stationId: string, id: string) =>
  checkedPluginOperation(stationId, await http(operationPath(stationId, id)), id);

export const inspectPluginOperation = async (stationId: string, id: string) =>
  checkedPluginOperation(stationId, await http(`${operationPath(stationId, id)}/inspect`, post({})), id);

export const applyPluginOperation = async (stationId: string, id: string, planDigest: string) =>
  checkedPluginOperation(stationId, await http(`${operationPath(stationId, id)}/apply`, post({ planDigest })), id);
