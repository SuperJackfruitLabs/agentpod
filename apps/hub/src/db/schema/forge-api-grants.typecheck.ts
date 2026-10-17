import type { ForgeGrantRef } from "../../services/forge-api/providers";
import type { StationForgeApiGrant } from "./forge-api-grants";

/**
 * Compile-time only (under src/ so `tsc` covers it; hub tests are not type-checked): the grants
 * row must structurally satisfy the provider adapters' ForgeGrantRef. Removing or retyping a
 * ForgeGrantRef field in the schema fails `tsc --noEmit`.
 */
export type RowSatisfiesForgeGrantRef = StationForgeApiGrant extends ForgeGrantRef ? true : never;
export const rowSatisfiesForgeGrantRef: RowSatisfiesForgeGrantRef = true;
export const _asRef = (r: StationForgeApiGrant): ForgeGrantRef => r;
