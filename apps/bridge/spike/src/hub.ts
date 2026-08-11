/**
 * AgentPod hub client for the spike.
 *
 * ⚠️ SERVICE-IDENTITY GAP — a finding in its own right.
 * The hub authenticates by cookie: routes read `c.get("user")` and the console
 * calls with `credentials: "include"`. There is no bearer or API-key path, so a
 * headless bridge has no service identity. The spike signs in as a human via
 * POST /api/auth/sign-in/email and reuses the session cookie. That is acceptable
 * for throwaway code and unacceptable for Horizon 2 — see the findings doc.
 *
 * Verified surface (packages/contract/src/acp-session.ts, hub routes/station-acp.ts):
 *   POST /api/stations/{station}/acp/sessions {mode}   → AcpSessionRow
 *   WS   /api/acp/sessions/{session}/ws
 *     client → {t:"subscribe",sinceSeq} | {t:"prompt",text}
 *              | {t:"permission-answer",requestSeq,optionId} | {t:"cancel"}
 *     server → {t:"event",event} | {t:"replay-done",lastSeq}
 *              | {t:"session",session} | {t:"bye",reason}
 */

import type { SpikeConfig } from "./config";

export interface AcpEvent {
  sessionId: string;
  seq: number;
  type: "user-prompt" | "agent-update" | "permission-request" | "permission-answer" | "state" | "error";
  payload: unknown;
  createdAt: string;
}

export type ServerMsg =
  | { t: "event"; event: AcpEvent }
  | { t: "replay-done"; lastSeq: number }
  | { t: "session"; session: { id: string; status: string } }
  | { t: "bye"; reason: string };

export async function signIn(c: SpikeConfig): Promise<string> {
  const res = await fetch(`${c.hubUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: c.hubEmail, password: c.hubPassword }),
  });
  if (!res.ok) throw new Error(`sign-in → ${res.status} ${await res.text()}`);
  const cookie = res.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("sign-in returned no Set-Cookie — check the hub auth config");
  return cookie;
}

export async function openSession(
  c: SpikeConfig,
  cookie: string,
  mode: "ask" | "accept-edits" | "full-auto" = "ask",
): Promise<{ id: string }> {
  const res = await fetch(`${c.hubUrl}/api/stations/${c.stationId}/acp/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`openSession → ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string };
}

export function connect(
  c: SpikeConfig,
  cookie: string,
  sessionId: string,
  onMsg: (msg: ServerMsg) => void,
): Promise<WebSocket> {
  const url = `${c.hubUrl.replace(/^http/, "ws")}/api/acp/sessions/${sessionId}/ws`;
  // Bun's WebSocket accepts headers; the browser one does not. Spike runs on Bun.
  const ws = new WebSocket(url, { headers: { Cookie: cookie } } as any);

  ws.addEventListener("message", (e) => {
    try {
      onMsg(JSON.parse(String((e as MessageEvent).data)) as ServerMsg);
    } catch {
      /* forward-compat: drop frames we cannot parse, same rule as the console */
    }
  });

  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ t: "subscribe", sinceSeq: 0 }));
      resolve(ws);
    });
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${String(e)}`)));
  });
}

/** A stable label for an event, destructuring agent-update's opaque payload. */
export function kindOf(event: AcpEvent): string {
  if (event.type !== "agent-update") return event.type;
  const u = (event.payload as any)?.sessionUpdate;
  return `agent-update:${u ?? "?"}`;
}
