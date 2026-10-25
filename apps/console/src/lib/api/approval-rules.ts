import { http } from "./client";

/** An agent's standing "Always allow" approval rule (approval scopes). */
export interface ApprovalRule {
  id: string;
  scope: "workspace-write";
  setBy: string;
  setAt: string;
}
const path = (stationId: string) => `/api/stations/${encodeURIComponent(stationId)}/approval-rules`;
const json = { "content-type": "application/json" };

export const listApprovalRules = async (stationId: string) =>
  (await http<{ rules: ApprovalRule[] }>(path(stationId))).rules;
export const setApprovalRule = async (stationId: string, scope: ApprovalRule["scope"]) =>
  (await http<{ rule: ApprovalRule }>(path(stationId), { method: "POST", headers: json, body: JSON.stringify({ scope }) })).rule;
export const revokeApprovalRule = async (stationId: string, ruleId: string) =>
  http<{ revoked: true }>(`${path(stationId)}/${encodeURIComponent(ruleId)}`, { method: "DELETE" });
