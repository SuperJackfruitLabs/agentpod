/**
 * The vocabulary of principals. The principals themselves, and their organizations, live at the
 * organization plane (contract §3.5); the hub's own `principals` and `organizations` tables were
 * dropped after the rollback window (P3 plan, Task 17). No table is defined here any more.
 */

export const PRINCIPAL_KINDS = ["human", "agent", "service"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];
