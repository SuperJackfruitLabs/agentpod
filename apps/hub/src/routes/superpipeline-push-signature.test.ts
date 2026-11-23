import { describe, expect, test } from "bun:test";
import { signDelivery } from "@superjackfruitlabs/treaty-cloudevents";
import { treatyText } from "../../tests/helpers/treaty-data";

import { createSuperpipelinePushRoutes, type SuperpipelinePushDeps } from "./superpipeline-push";

/**
 * The direct push on the relay's envelope (treaty phase 2, ruling 1): every delivery is signed with
 * `x-treaty-signature` over `<t>.<ce-id>.<body>`, the push config's token as the secret. Held to
 * treaty's own vectors (`fixtures/cloudevents/push-delivery.json`): each delivery verifies at the
 * second it was signed, and each refusal is refused. The older `X-Superpipeline-Signature` is the
 * fallback until SuperPipeline's cleanup change, and only when the new header is absent.
 */

interface Vector {
  name: string;
  secret: string;
  http: { headers: Record<string, string>; body: string };
}
interface Corpus {
  deliveries: Array<Vector & { t: number }>;
  refuse: Array<Vector & { nowSeconds: number; why: string }>;
}

const corpus: Corpus = JSON.parse(treatyText("fixtures/cloudevents/push-delivery.json"));

function deps(secret: string, nowSeconds: number, over: Partial<SuperpipelinePushDeps> = {}): SuperpipelinePushDeps {
  return {
    secret,
    domain: "id.agentpod.dev",
    // No board is mapped, so a verified gate stops before any room or database.
    tenantIdFor: async () => null,
    boardRoom: async () => null,
    sendText: async () => "$prose",
    sendCustomEvent: async () => "$gate",
    wakeBoard: () => 0,
    now: () => nowSeconds * 1000,
    ...over,
  };
}

function door(body: string): string {
  const parsed: { event?: string } = JSON.parse(body);
  return parsed.event === "work.available" ? "/bridge/superpipeline/work" : "/bridge/superpipeline/push";
}

async function send(d: SuperpipelinePushDeps, headers: Record<string, string>, body: string) {
  return createSuperpipelinePushRoutes(d).request(door(body), { method: "POST", headers, body });
}

async function legacy(secret: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("treaty's push delivery vectors", () => {
  test("the corpus has deliveries and refusals to hold the receiver to", () => {
    expect(corpus.deliveries.length).toBeGreaterThan(0);
    expect(corpus.refuse.length).toBeGreaterThan(0);
  });

  for (const v of corpus.deliveries) {
    test(`accepts ${v.name}, signed at its own second`, async () => {
      const res = await send(deps(v.secret, v.t), v.http.headers, v.http.body);
      expect(res.status).not.toBe(401);
    });
  }

  for (const v of corpus.refuse) {
    test(`refuses ${v.name}: ${v.why}`, async () => {
      const res = await send(deps(v.secret, v.nowSeconds), v.http.headers, v.http.body);
      expect(res.status).toBe(401);
    });
  }
});

describe("the signature the push carries", () => {
  const work = corpus.deliveries.find((v) => v.name === "work.available");
  if (!work) throw new Error("treaty's corpus lost its work.available vector");

  test("a verified x-treaty-signature reaches the handler", async () => {
    const woken: string[] = [];
    const res = await send(deps(work.secret, work.t, { wakeBoard: (b) => (woken.push(b), 1) }), work.http.headers, work.http.body);
    expect(res.status).toBe(200);
    expect(woken).toEqual([JSON.parse(work.http.body).boardId]);
  });

  test("a bad x-treaty-signature is refused even beside a good old one: no downgrade", async () => {
    const headers = {
      ...work.http.headers,
      "x-treaty-signature": await signDelivery("not-the-secret", work.http.headers["ce-id"] ?? "", new TextEncoder().encode(work.http.body), work.t * 1000),
      "X-Superpipeline-Signature": await legacy(work.secret, work.http.body),
    };
    expect((await send(deps(work.secret, work.t), headers, work.http.body)).status).toBe(401);
  });

  test("the signature binds the event id: the same body under another ce-id is refused", async () => {
    const headers = { ...work.http.headers, "ce-id": "brd_134a0ddb6d434478:999" };
    expect((await send(deps(work.secret, work.t), headers, work.http.body)).status).toBe(401);
  });

  test("a board that predates the move, with only the old signature, is still accepted", async () => {
    const headers = { "content-type": "application/json", "X-Superpipeline-Signature": await legacy(work.secret, work.http.body) };
    expect((await send(deps(work.secret, work.t), headers, work.http.body)).status).toBe(200);
  });

  test("a delivery with neither signature is refused", async () => {
    expect((await send(deps(work.secret, work.t), { "content-type": "application/json" }, work.http.body)).status).toBe(401);
  });
});
