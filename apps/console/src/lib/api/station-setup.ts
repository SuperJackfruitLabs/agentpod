import { http } from "./client";
export interface SetupAgent {
  id: string;
  handle: string;
  displayName: string | null;
  dispatchers: string[];
}
export interface SetupOptions {
  agents: SetupAgent[];
  matrixDomain: string | null;
}
export interface SetupInput {
  requestId: string;
  agent:
    | { kind: "new"; handle: string; displayName: string }
    | { kind: "existing"; principalId: string };
  dispatch: "me" | "none";
}
export interface SetupResult {
  principalId: string | null;
  matrix: {
    status: "provisioned" | "pending" | "failed" | "no-bridge";
    address: string | null;
    roomId: string | null;
    mode: string;
    error?: string | null;
  };
}
export const getSetupOptions = () =>
  http<SetupOptions>("/api/admin/station-setup/options");
export const getStationSetup = (id: string) =>
  http<SetupResult>(`/api/admin/stations/${encodeURIComponent(id)}/setup`);
export const completeStationSetup = (id: string, input: SetupInput) =>
  http<SetupResult>(`/api/admin/stations/${encodeURIComponent(id)}/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
export const retryStationMatrix = (id: string, principalId: string) =>
  http<SetupResult>(
    `/api/admin/stations/${encodeURIComponent(id)}/setup/matrix`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ principalId }),
    },
  );
export const removeStation = (id: string) =>
  http<void>(`/api/stations/${encodeURIComponent(id)}`, { method: "DELETE" });
