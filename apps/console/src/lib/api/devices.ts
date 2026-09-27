/**
 * The machines that may act as you.
 *
 * `charter → decisions/2026-09-18-a-human-at-a-terminal-has-nothing-to-exchange.md`,
 * accepted 2026-09-20. A person at a terminal holds a 90-day device credential and
 * exchanges it for five-minute tokens rather than opening a browser every five
 * minutes. The record asks that a device be "a thing an operator can see and name
 * in a list", and that it be revocable.
 *
 * **The CLI can already print that list, and this exists anyway.** A list only a
 * CLI can print is not a revocation surface for the person whose laptop was
 * stolen — who is, by then, not at that laptop. That is the whole argument for
 * this screen.
 */

import { http } from "./client";

export interface DeviceCredential {
  id: string;
  name: string;
  createdAt: string;
  /** Null until the first exchange — a distinct state from "used long ago". */
  lastUsedAt: string | null;
  expiresAt: string;
  /** Set rather than deleted, so a revoked device stays visible in the list it left from. */
  revokedAt: string | null;
}

export const listDevices = () =>
  http<{ devices: DeviceCredential[] }>("/api/auth/devices").then((r) => r.devices);

export const revokeDevice = (id: string) =>
  http<{ revoked: boolean }>(`/api/auth/devices/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Live, expired and revoked are three different things an operator acts on differently. */
export type DeviceState = "active" | "revoked" | "expired";

export function deviceState(d: DeviceCredential, now: number = Date.now()): DeviceState {
  // Revoked wins over expired: somebody DID something, and a list that showed
  // "expired" for a device they revoked would hide the fact that their action landed.
  if (d.revokedAt) return "revoked";
  if (new Date(d.expiresAt).getTime() <= now) return "expired";
  return "active";
}

/**
 * "2 minutes ago", "6 days ago", or "never used".
 *
 * Relative rather than a timestamp because the question this list answers is
 * "which of these is the laptop I lost" — and recency is what distinguishes the
 * machine in your hand from the one in a drawer.
 */
export function lastUsedLabel(d: DeviceCredential, now: number = Date.now()): string {
  if (!d.lastUsedAt) return "never used";
  const ms = now - new Date(d.lastUsedAt).getTime();
  if (Number.isNaN(ms)) return "never used";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
